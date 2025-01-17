import { ActionCallback, BasicBlock } from '@policy-engine/helpers/decorators';
import { Inject } from '@helpers/decorators/inject';
import { Users } from '@helpers/users';
import { BlockActionError } from '@policy-engine/errors';
import { DocumentSignature, GenerateUUIDv4, SchemaEntity, SchemaHelper } from '@guardian/interfaces';
import { PolicyValidationResultsContainer } from '@policy-engine/policy-validation-results-container';
import { PolicyComponentsUtils } from '@policy-engine/policy-components-utils';
import { CatchErrors } from '@policy-engine/helpers/decorators/catch-errors';
import { VcDocument, VCMessage, MessageAction, MessageServer, VPMessage } from '@hedera-modules';
import { VcHelper } from '@helpers/vc-helper';
import { getMongoRepository } from 'typeorm';
import { Token as TokenCollection } from '@entity/token';
import { DataTypes, PolicyUtils } from '@policy-engine/helpers/utils';
import { AnyBlockType } from '@policy-engine/policy-engine.interface';
import { IPolicyEvent, PolicyInputEventType, PolicyOutputEventType } from '@policy-engine/interfaces';
import { ChildrenType, ControlType } from '@policy-engine/interfaces/block-about';
import { IAuthUser } from '@guardian/common';

/**
 * Mint block
 */
@BasicBlock({
    blockType: 'mintDocumentBlock',
    commonBlock: true,
    publishExternalEvent: true,
    about: {
        label: 'Mint',
        title: `Add 'Mint' Block`,
        post: false,
        get: false,
        children: ChildrenType.None,
        control: ControlType.Server,
        input: [
            PolicyInputEventType.RunEvent
        ],
        output: [
            PolicyOutputEventType.RunEvent,
            PolicyOutputEventType.RefreshEvent
        ],
        defaultEvent: true
    }
})
export class MintBlock {
    /**
     * Users helper
     * @private
     */
    @Inject()
    private readonly users: Users;

    /**
     * Create mint VC
     * @param root
     * @param token
     * @param data
     * @param ref
     * @private
     */
    private async createMintVC(root: any, token: any, data: any, ref: AnyBlockType): Promise<VcDocument> {
        const vcHelper = new VcHelper();
        const policySchema = await PolicyUtils.getSchema(ref.topicId, SchemaEntity.MINT_TOKEN);
        const amount = data as string;
        const vcSubject = {
            ...SchemaHelper.getContext(policySchema),
            date: (new Date()).toISOString(),
            tokenId: token.tokenId,
            amount: amount.toString()
        }
        const mintVC = await vcHelper.createVC(
            root.did,
            root.hederaAccountKey,
            vcSubject
        );
        return mintVC;
    }

    /**
     * Create VP
     * @param root
     * @param uuid
     * @param vcs
     * @private
     */
    private async createVP(root, uuid: string, vcs: VcDocument[]) {
        const vcHelper = new VcHelper();
        const vp = await vcHelper.createVP(
            root.did,
            root.hederaAccountKey,
            vcs,
            uuid
        );
        return vp;
    }

    /**
     * Mint processing
     * @param token
     * @param documents
     * @param relationships
     * @param topicId
     * @param root
     * @param user
     * @private
     */
    private async mintProcessing(
        token: TokenCollection,
        documents: VcDocument[],
        relationships: string[],
        topicId: string,
        root: any,
        user: IAuthUser,
        targetAccountId: string
    ): Promise<any> {
        const ref = PolicyComponentsUtils.GetBlockRef(this);

        const uuid = GenerateUUIDv4();
        const amount = PolicyUtils.aggregate(ref.options.rule, documents);

        if (Number.isNaN(amount) || !Number.isFinite(amount)) {
            throw new BlockActionError(`Invalid token value: ${amount}`, ref.blockType, ref.uuid);
        }

        const [tokenValue, tokenAmount] = PolicyUtils.tokenAmount(token, amount);
        const mintVC = await this.createMintVC(root, token, tokenAmount, ref);
        const vcs = [].concat(documents, mintVC);
        const vp = await this.createVP(root, uuid, vcs);

        const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey);
        ref.log(`Topic Id: ${topicId}`);
        let topic: any;
        if (topicId) {
            topic = await PolicyUtils.getTopicById(topicId, ref);
        } else {
            topic = await PolicyUtils.getTopic('root', root, user, ref);
        }
        ref.log(`Topic Id: ${topic?.id}`);

        const vcMessage = new VCMessage(MessageAction.CreateVC);
        vcMessage.setDocument(mintVC);
        vcMessage.setRelationships(relationships);
        const vcMessageResult = await messageServer
            .setTopicObject(topic)
            .sendMessage(vcMessage);

        await PolicyUtils.updateVCRecord(
            PolicyUtils.createVCRecord(
                ref.policyId,
                ref.tag,
                DataTypes.MINT,
                mintVC,
                {
                    owner: user.did,
                    schema: `#${mintVC.getSubjectType()}`,
                    messageId: vcMessageResult.getId(),
                    topicId: vcMessageResult.getTopicId(),
                    relationships
                }
            )
        );

        relationships.push(vcMessageResult.getId());
        const vpMessage = new VPMessage(MessageAction.CreateVP);
        vpMessage.setDocument(vp);
        vpMessage.setRelationships(relationships);

        const vpMessageResult = await messageServer
            .setTopicObject(topic)
            .sendMessage(vpMessage);

        await PolicyUtils.saveVP({
            hash: vp.toCredentialHash(),
            document: vp.toJsonTree(),
            owner: user.did,
            type: DataTypes.MINT,
            policyId: ref.policyId,
            tag: ref.tag,
            messageId: vpMessageResult.getId(),
            topicId: vpMessageResult.getTopicId(),
        } as any);

        await PolicyUtils.mint(ref, token, tokenValue, root, targetAccountId, vpMessageResult.getId());

        return vp;
    }

    /**
     * Run action
     * @event PolicyEventType.Run
     * @param {IPolicyEvent} event
     */
    @ActionCallback({
        output: [PolicyOutputEventType.RunEvent, PolicyOutputEventType.RefreshEvent]
    })
    @CatchErrors()
    async runAction(event: IPolicyEvent<any>) {
        const ref = PolicyComponentsUtils.GetBlockRef(this);

        const token = await getMongoRepository(TokenCollection).findOne({
            tokenId: ref.options.tokenId
        });
        if (!token) {
            throw new BlockActionError('Bad token id', ref.blockType, ref.uuid);
        }

        const docs = PolicyUtils.getArray<any>(event.data.data);
        if (!docs.length && docs[0]) {
            throw new BlockActionError('Bad VC', ref.blockType, ref.uuid);
        }

        const docOwner = await this.users.getUserById(docs[0].owner);
        if (!docOwner) {
            throw new BlockActionError('Bad User DID', ref.blockType, ref.uuid);
        }

        const vcs: VcDocument[] = [];
        const vsMessages: string[] = [];
        const topicIds: string[] = [];
        const field = ref.options.accountId || 'default';
        const accounts: string[] = [];
        for (const doc of docs) {
            if (doc.signature === DocumentSignature.INVALID) {
                throw new BlockActionError('Invalid VC proof', ref.blockType, ref.uuid);
            }
            const json = VcDocument.fromJsonTree(doc.document);

            vcs.push(json);
            if (doc.messageId) {
                vsMessages.push(doc.messageId);
            }
            if (doc.topicId) {
                topicIds.push(doc.topicId);
            }
            if (doc.accounts) {
                const accountId: string = doc.accounts[field];
                accounts.push(accountId);
            }
        }

        const firstAccounts = accounts[0];
        if (accounts.find(a => a !== firstAccounts)) {
            ref.error(`More than one account found! Transfer made on the first (${firstAccounts})`);
        }
        const topicId = topicIds[0];

        const targetAccountId: string = ref.options.accountId ?
            firstAccounts :
            docOwner.hederaAccountId;

        if (!targetAccountId) {
            throw new BlockActionError('Token recipient not set', ref.blockType, ref.uuid);
        }

        const root = await this.users.getHederaAccount(ref.policyOwner);
        await this.mintProcessing(token, vcs, vsMessages, topicId, root, docOwner, targetAccountId);

        ref.triggerEvents(PolicyOutputEventType.RunEvent, docOwner, event.data);
        ref.triggerEvents(PolicyOutputEventType.RefreshEvent, docOwner, event.data);
    }

    /**
     * Validate block options
     * @param resultsContainer
     */
    public async validate(resultsContainer: PolicyValidationResultsContainer): Promise<void> {
        const ref = PolicyComponentsUtils.GetBlockRef(this);
        try {
            if (!ref.options.tokenId) {
                resultsContainer.addBlockError(ref.uuid, 'Option "tokenId" does not set');
            } else if (typeof ref.options.tokenId !== 'string') {
                resultsContainer.addBlockError(ref.uuid, 'Option "tokenId" must be a string');
            } else if (!(await getMongoRepository(TokenCollection).findOne({ tokenId: ref.options.tokenId }))) {
                resultsContainer.addBlockError(ref.uuid, `Token with id ${ref.options.tokenId} does not exist`);
            }

            if (!ref.options.rule) {
                resultsContainer.addBlockError(ref.uuid, 'Option "rule" does not set');
            } else if (typeof ref.options.rule !== 'string') {
                resultsContainer.addBlockError(ref.uuid, 'Option "rule" must be a string');
            }

            const accountType = ['default', 'custom'];
            if (accountType.indexOf(ref.options.accountType) === -1) {
                resultsContainer.addBlockError(ref.uuid, 'Option "accountType" must be one of ' + accountType.join(','));
            }
            if (ref.options.accountType === 'custom' && !ref.options.accountId) {
                resultsContainer.addBlockError(ref.uuid, 'Option "accountId" does not set');
            }
        } catch (error) {
            resultsContainer.addBlockError(ref.uuid, `Unhandled exception ${error.message}`);
        }
    }
}
