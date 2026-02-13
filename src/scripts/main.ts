import { AbilityItemPF2e, ActorPF2e, ChatMessageFlagsPF2e, ChatMessagePF2e, CheckContextChatFlag, CheckRoll, DamageRoll, DegreeOfSuccessIndex, DegreeOfSuccessString, ItemOriginFlag, ItemPF2e, MeasuredTemplateDocumentPF2e, MeasuredTemplatePF2e, SaveType, SpellPF2e, TokenDocumentPF2e, TokenPF2e, WeaponPF2e, ZeroToThree } from "foundry-pf2e";
import { Rolled } from "foundry-pf2e/foundry/client/dice/roll.mjs";
import { ChatMessageCreateOperation } from "foundry-pf2e/foundry/client/documents/chat-message.mjs";
import { DatabaseUpdateOperation, DatabaseCreateOperation } from "foundry-pf2e/foundry/common/abstract/_module.mjs";
import { TokenDocumentUUID } from "foundry-pf2e/foundry/common/documents/_module.mjs";
import { createHTMLElement, htmlQuery, htmlQueryAll } from "./imports/dom.ts";
import { extractEphemeralEffects } from "./imports/rules/helpers.ts";
import { DEGREE_OF_SUCCESS, DEGREE_OF_SUCCESS_STRINGS } from "./imports/degree-of-success.ts";
import { SAVE_TYPES } from "./imports/actor/values.ts";


const MODULE_NAME: string = "pf2e-saves-helper";
const SOCKET_NAME: string = `module.${MODULE_NAME}`;
var SYSTEM_ID: SystemId = "pf2e";
const SETTINGS = {
    HIDE_SAVING_THROWS: "hideSavingThrows",
    IGNORE_HEALING_SAVES: "ignoreHealingSaves",
    APPLY_HEALING: "applyHealing",
    SKIP_MULTIPLE_ROLL_DIALOG: "skipMultipleRollDialog",
};

const APPLICABLE_MESSAGE_TYPES = ["spell", "action", "feat", "weapon"] as const;
type ApplicableMessageType = (typeof APPLICABLE_MESSAGE_TYPES)[number];

type SavesFlag = {
    label?: {
        value: string,
        gmOnly: boolean
    },
    targets: string[],
    sourceMessage?: string,
    saveInfo?: SaveInfo,
    origin?: ItemOriginFlag | null,
    results: Record<string, SaveResult>,
    damageMessage?: string
};

type SaveInfo = {
    saveType: SaveType,
    basic: boolean
    dc: number,
    extraRollOptions?: string[]
};

type SaveResult = {
    degreeOfSuccess: DegreeOfSuccessIndex,
    rollValue: number
};

type SavesHelperSocketMessage =
    UpdateAppliedMessage
    | SaveRolledMessage
    | { type: string };

type SaveRolledMessage = {
    type: "save-rolled",
    message: string,
    token: TokenDocumentUUID,
    degreeOfSuccess: ZeroToThree,
    rollValue: number
}

type UpdateAppliedMessage = {
    type: "update-applied",
    message: string,
    token: TokenDocumentUUID
};

function uuidConvert(uuid: string) { return uuid.replaceAll(".", "-"); }

Hooks.once("init", () => {
    SYSTEM_ID = game.system.id as SystemId;
    game.socket.on(SOCKET_NAME, (message: SavesHelperSocketMessage) => handleSocketMessage(message));
    game.settings.register(MODULE_NAME, SETTINGS.HIDE_SAVING_THROWS, {
        scope: "world",
        config: true,
        name: "PF2E-SAVES-HELPER.Settings.HideSavingThrows",
        hint: "PF2E-SAVES-HELPER.Settings.HideSavingThrowsHint",
        type: Boolean,
        default: false
    });
    game.settings.register(MODULE_NAME, SETTINGS.IGNORE_HEALING_SAVES, {
        scope: "world",
        config: true,
        name: "PF2E-SAVES-HELPER.Settings.IgnoreHealingSaves",
        hint: "PF2E-SAVES-HELPER.Settings.IgnoreHealingSavesHint",
        type: Boolean,
        default: true
    });
    game.settings.register(MODULE_NAME, SETTINGS.APPLY_HEALING, {
        scope: "world",
        config: true,
        name: "PF2E-SAVES-HELPER.Settings.ApplyHealing",
        hint: "PF2E-SAVES-HELPER.Settings.ApplyHealingHint",
        type: Boolean,
        default: true,
        requiresReload: false
    });
    game.settings.register(MODULE_NAME, SETTINGS.SKIP_MULTIPLE_ROLL_DIALOG, {
        scope: "client",
        config: true,
        name: "PF2E-SAVES-HELPER.Settings.SkipMultipleRollDialog",
        hint: "PF2E-SAVES-HELPER.Settings.SkipMultipleRollDialogHint",
        type: Boolean,
        default: false,
        requiresReload: false
    });
});

function handleSocketMessage(message: SavesHelperSocketMessage) {
    if (!message)
        return;

    switch (message.type) {
        case "update-applied":
            handleUpdateApplied(message as UpdateAppliedMessage);
            break;
        case "save-rolled":
            handleSaveRolled(message as SaveRolledMessage);
            break;
    }
}

async function handleSaveRolled(message: SaveRolledMessage) {
    if (!game.user.isGM)
        return;

    const chatMessage = game.messages.get(message.message);
    if (!chatMessage)
        return;
    const savesFlag = chatMessage.flags[MODULE_NAME] as SavesFlag;
    const resultEntry = { degreeOfSuccess: message.degreeOfSuccess, rollValue: message.rollValue };
    savesFlag.results[uuidConvert(message.token)] = resultEntry;

    chatMessage.update({
        [`flags.${MODULE_NAME}.results.${uuidConvert(message.token)}`]: resultEntry,
        content: await getSavesMessageContent(savesFlag)
    });
}

function handleUpdateApplied(message: UpdateAppliedMessage) {
    if (!game.user.isGM)
        return;

    const damageMessage = game.messages.get(message.message);
    if (!damageMessage || !damageMessage.flags[MODULE_NAME])
        return;

    updateAppliedToken(damageMessage, message.token);
}

async function updateAppliedToken(message: ChatMessagePF2e, tokenUuid: TokenDocumentUUID) {
    await message.update({ [`flags.${MODULE_NAME}.applied.${uuidConvert(tokenUuid)}`]: true });
}

async function createSavesMessage(message: ChatMessagePF2e, messageFlags: ChatMessageFlagsPF2e, saveInfo?: SaveInfo) {
    if (!messageFlags || !messageFlags[SYSTEM_ID] || !saveInfo)
        return;

    const savesFlag = createSavesFlag(message, messageFlags, saveInfo);
    const savesMessage = await ChatMessage.create({
        content: await getSavesMessageContent(savesFlag),
        speaker: message.speaker,
        flags: {
            [MODULE_NAME]: savesFlag
        }
    });
    
    if (savesMessage)
        await message.update({
            [`flags.${MODULE_NAME}.savesMessage`]: savesMessage.id
        });
}

async function updateSavesMessage(messageId: string, sourceMessage: ChatMessagePF2e, messageFlags: ChatMessageFlagsPF2e, saveInfo?: SaveInfo) {
    if (!messageFlags || !messageFlags[SYSTEM_ID])
        return;

    const savesFlag = createSavesFlag(sourceMessage, messageFlags, saveInfo);
    await ChatMessage.updateDocuments([{ _id: messageId, content: getSavesMessageContent(savesFlag), [`flags.${MODULE_NAME}`]: savesFlag }]);
}

function onSpellMessageCreated(message: ChatMessagePF2e) {
    let origin = message.flags[SYSTEM_ID]?.origin;
    if (!origin)
        return;

    const spell = fromUuidSync<SpellPF2e>(origin.uuid);

    if (!spell)
        return;

    // if the spell has variants, we deal with it in the message update
    if (spell.hasVariants)
        return;

    // if the spell has no saving throws
    if (!spell.system.defense?.save)
        return;

    createSavesMessage(message, message.flags, getSaveInfoFromSpell(spell));
}

function getSaveInfoFromSpell(spell: SpellPF2e): SaveInfo | undefined {
    const save = spell.system.defense?.save;
    if (!save)
        return undefined;
    return {
        saveType: save?.statistic,
        basic: save?.basic,
        dc: spell.spellcasting?.statistic?.dc.value ?? 0
    };
}

function onWeaponMessageCreated(message: ChatMessagePF2e) {
    if (!message._attack)
        return;

    createSavesMessage(message, message.flags, getSaveInfoFromAttack(message._attack))
}

function getSaveInfoFromAttack(attack: any): SaveInfo | undefined {
    if (!("statistic" in attack))
        return undefined;
    return {
        saveType: "reflex",
        basic: true,
        dc: attack.statistic.dc.value
    };
}

const SAVE_REGEX = /<a class="inline-check.+?data-pf2-check="(?:fortitude|reflex|will)".+?<\/a>/g;

function onActionMessageCreated(message: ChatMessagePF2e) {
    let origin = message.flags[SYSTEM_ID]?.origin;
    if (!origin)
        return;

    const action = fromUuidSync<AbilityItemPF2e>(origin.uuid);

    if (!action)
        return;

    const linkFound = message.content.match(SAVE_REGEX);

    if (!linkFound || linkFound.length <= 0)
        return;

    const link = createHTMLElement("div", { innerHTML: linkFound[0] })?.firstChild as HTMLElement | null;

    if (!link || !link.dataset)
        return;

    const basicString = game.i18n.format("PF2E.InlineCheck.BasicWithSave", { save: link.dataset.pf2Check ? game.i18n.localize(CONFIG.PF2E.saves[link.dataset.pf2Check as SaveType]) : "" });
    const basic = linkFound[0].includes(basicString);
    let actor: ActorPF2e | undefined = undefined;
    if (link.dataset.against && origin.actor) {
        actor = fromUuidSync(origin.actor) as ActorPF2e ?? undefined;
        if (!actor)
            return;
    }
    createSavesMessage(message, message.flags, getSaveInfoFromDataset(link.dataset, basic, actor));
}

function getSaveInfoFromDataset(dataset: DOMStringMap, basic: boolean, actor?: ActorPF2e): SaveInfo | undefined {
    if (!dataset)
        return undefined;
    const { pf2Check, pf2Dc, against, pf2RollOptions, pf2Traits } = dataset;

    if (!pf2Check || !SAVE_TYPES.includes(pf2Check as SaveType) || (!pf2Dc && !against))
        return undefined;

    let dc = pf2Dc ? Number(pf2Dc) : undefined;
    if (against) {
        dc = actor?.getStatistic(against)?.dc.value;
    }

    if (!dc)
        return undefined;

    return {
        saveType: pf2Check as SaveType,
        dc: dc,
        basic: basic,
        extraRollOptions: [...pf2RollOptions?.split(",") ?? [], ...pf2Traits?.split(",") ?? []]
    };
}

function createSavesFlag(message: ChatMessagePF2e, messageFlags: ChatMessageFlagsPF2e, saveInfo?: SaveInfo): SavesFlag {
    if (!saveInfo)
        return {
            targets: [], results: {}
        } satisfies SavesFlag;
    const targets = game.user.targets.filter(t => filterTarget(t, false, saveInfo.saveType)).map(t => t.document.uuid);
    const item = fromUuidSync(messageFlags[SYSTEM_ID]?.origin?.uuid ?? "");
    return {
        label: item?.name ? {
            value: item.name,
            gmOnly: message.whisper.length == 0 ? false : message.whisper.includes(game.users.activeGM?.id ?? "")
        } : undefined,
        targets: [...targets],
        sourceMessage: message.id,
        saveInfo: saveInfo,
        origin: messageFlags[SYSTEM_ID].origin,
        results: {}
    } satisfies SavesFlag;
}

Hooks.on("createChatMessage", (message: ChatMessagePF2e, options: ChatMessageCreateOperation, userId: string) => {
    if (userId !== game.user.id)
        return;
    let flags = message.flags[SYSTEM_ID];
    if (!flags)
        return;
    if (flags.context?.type === "spell-cast" && flags.origin) {
        onSpellMessageCreated(message);
    } else if (flags.context?.type === "area-fire" || flags.context?.type === "auto-fire") {
        onWeaponMessageCreated(message);
    } else if (flags.context?.type === "damage-roll") {
        onDamageMessageCreated(message);
    } else if (!flags.context && (flags.origin?.type === "action" || flags.origin?.type === "feat")) {
        onActionMessageCreated(message);
    }
});

Hooks.on("preUpdateChatMessage", (message: ChatMessagePF2e, changed: Record<string, ChatMessageFlagsPF2e>, options: DatabaseUpdateOperation<ChatMessage>, userId: string) => {
    if (!changed.flags[SYSTEM_ID])
        return;
    const changedFlags = changed.flags[SYSTEM_ID];

    // Handle spell variants
    let origin = message.flags[SYSTEM_ID]?.origin;
    if (game.user.id === userId && changedFlags.context?.type === "spell-cast" && changedFlags.origin && origin) {
        const spell = fromUuidSync<SpellPF2e>(origin.uuid);
        let noSave = false;
        if (!spell)
            noSave = true;
        else if (spell.hasVariants) {
            const changedOrigin = changedFlags.origin;
            if (changedOrigin.variant) {
                const variant = spell.overlays.overrideVariants.find(s => changedOrigin.variant && s.variantId === changedOrigin.variant.overlays[0]);
                if (!variant || !variant.system.defense?.save)
                    noSave = true;
                else {
                    if (message.flags[MODULE_NAME]?.savesMessage) {
                        updateSavesMessage(message.flags[MODULE_NAME].savesMessage as string, message, changed.flags, getSaveInfoFromSpell(variant));
                    }
                    else {
                        createSavesMessage(message, changed.flags, getSaveInfoFromSpell(variant));
                    }
                }
            }
            else {
                noSave = true;
            }
        }

        if (noSave && message.flags[MODULE_NAME]?.savesMessage) {
            ChatMessage.deleteDocuments([message.flags[MODULE_NAME].savesMessage as string]);
            message.update({ [`flags.${MODULE_NAME}.-=savesMessage`]: null });
        }
    }
});

Hooks.on("updateChatMessage", async (message: ChatMessagePF2e, changed: Record<string, ChatMessageFlagsPF2e>) => {
    if (message.flags[MODULE_NAME]?.sourceMessage) {
        refreshAndScroll(message);

        if (message.flags[MODULE_NAME]?.damageMessage) {
            const damageMessage = game.messages.get(message.flags[MODULE_NAME].damageMessage as string);
            if (damageMessage) {
                await ui.chat.updateMessage(damageMessage);
                // Update popout chat windows
                for (let appId in ui.windows) {
                    if (ui.windows[appId] instanceof foundry.applications.sidebar.apps.ChatPopout && ui.windows[appId].message.id === damageMessage.id)
                        ui.windows[appId].render(true);
                }
            }
        }
    }
});

async function refreshAndScroll(message: ChatMessagePF2e) {
    await ui.chat.updateMessage(message);
    if (game.messages.contents[game.messages.contents.length - 1] == message)
        ui.chat.scrollBottom({ waitImages: true });
}

async function getSavesMessageContent(savesFlag: SavesFlag): Promise<string> {
    let tokenDocList = savesFlag.targets?.map(t => fromUuidSync(t) as TokenDocumentPF2e).filter(t => t);
    const saveInfo = savesFlag.saveInfo;

    const savesLabel = ((): string | null => {
        if (!saveInfo)
            return null;
        const saveKey = saveInfo.basic ? "PF2E.SaveDCLabelBasic" : "PF2E.SaveDCLabel";
        const localized = game.i18n.format(saveKey, {
            dc: saveInfo.dc,
            type: game.i18n.localize(CONFIG.PF2E.saves[saveInfo.saveType])
        });
        const tempElement = createHTMLElement("div", { innerHTML: localized });
        game.pf2e.TextEditor.convertXMLNode(tempElement, "dc", { visibility: game.pf2e.settings.metagame.dcs ? "all" : "owner", whose: null });
        return tempElement.innerHTML;
    })();

    let tokenList: Record<string, any>[] = [];

    for (let tokenDoc of tokenDocList) {
        const hidden = tokenDoc.hidden ? "gm" : "all";

        const name = tokenDoc.name;

        const tokenUuid = tokenDoc.uuid;
        const playerOwned = tokenDoc.hasPlayerOwner ? "pc" : "npc";

        // Token Image
        const [imageUrl, scale] = (() => {
            const tokenImage = tokenDoc.texture.src;
            const hasTokenImage = tokenImage && foundry.helpers.media.ImageHelper.hasImageExtension(tokenImage);
            if (!hasTokenImage)
                return [tokenDoc.actor?.img, 1];

            // Calculate the correction factor for dynamic tokens.
            // Prototype tokens do not have access to subjectScaleAdjustment so we recompute using default values
            const defaultRingThickness = 0.1269848;
            const defaultSubjectThickness = 0.6666666;
            const scaleCorrection = tokenDoc.ring.enabled ? 1 / (defaultRingThickness + defaultSubjectThickness) : 1;
            return [tokenImage, Math.max(1, tokenDoc.texture.scaleX) * scaleCorrection];
        })();

        const image = document.createElement("img");
        image.alt = tokenDoc.name;
        image.src = imageUrl as string;
        image.style.transform = `scale(${scale})`;

        // If image scale is above 1.2, we might need to add a radial fade to not block out the name
        if (scale > 1.2) {
            const ringPercent = 100 - Math.floor(((scale - 0.7) / scale) * 100);
            const limitPercent = 100 - Math.floor(((scale - 1.15) / scale) * 100);
            image.style.maskImage = `radial-gradient(circle at center, black ${ringPercent}%, rgba(0, 0, 0, 0.2) ${limitPercent}%)`;
        }

        const healingTraits = game.settings.get(MODULE_NAME, SETTINGS.IGNORE_HEALING_SAVES) && savesFlag.origin?.rollOptions?.some(t => t === "healing") ? getHealingTraitsFromOptions(savesFlag.origin?.rollOptions) : null;

        // Saves results
        const convertedUuid = uuidConvert(tokenDoc.uuid);
        const healed = healingTraits && canApplyHealing(tokenDoc.actor, healingTraits);
        const hasResult = savesFlag.results[convertedUuid];

        const result = hasResult ? savesFlag.results[convertedUuid] : null;
        const degreeOfSuccess = result ? DEGREE_OF_SUCCESS_STRINGS[result.degreeOfSuccess] : "failure";
        const rollValue = result ? result.rollValue.toFixed() : 0;
        const degreeOfSuccessLabel = "PF2E.Check.Result.Degree.Check." + degreeOfSuccess;

        tokenList.push({
            name,
            hidden,
            tokenUuid,
            image: image.outerHTML,
            hasResult,
            healed,
            degreeOfSuccess,
            rollValue,
            degreeOfSuccessLabel,
            playerOwned
        });
    }
    return foundry.applications.handlebars.renderTemplate(`modules/${MODULE_NAME}/templates/saves-message.hbs`, { label: savesFlag.label?.value, labelVisibility: savesFlag.label?.gmOnly ? "gm" : "all", savesLabel: savesLabel, tokenList: tokenList });
}

Hooks.on("renderChatMessageHTML", async (message: ChatMessagePF2e, html: HTMLElement) => {
    if (message.flags[MODULE_NAME]?.sourceMessage)
        addSavesMessageListeners(message, html);
    else if (message.flags[SYSTEM_ID]?.context?.type === "damage-roll" && message.flags[MODULE_NAME])
        onRenderDamageMessage(message, html);
});

Hooks.on("createMeasuredTemplate", async (measuredTemplate: MeasuredTemplateDocumentPF2e, options: DatabaseCreateOperation<MeasuredTemplateDocumentPF2e>, userId: string) => {
    let messageId = measuredTemplate.flags[SYSTEM_ID]?.messageId;
    if (!messageId || game.userId != userId)
        return;

    const sourceMessage = game.messages.get(messageId);
    if (!sourceMessage || !sourceMessage.flags[MODULE_NAME]?.savesMessage || !sourceMessage.isAuthor)
        return;

    const savesMessage = game.messages.get(sourceMessage.flags[MODULE_NAME]?.savesMessage as string);
    if (!savesMessage || !savesMessage.flags[MODULE_NAME])
        return;

    const savesFlag = savesMessage.flags[MODULE_NAME] as SavesFlag;

    const saveType = savesFlag.saveInfo?.saveType;
    if (!saveType)
        return;

    await new Promise<void>(resolve => Hooks.once("refreshMeasuredTemplate", () => { resolve(); }));

    const tokenList = getTemplateTokens(measuredTemplate).filter(t => filterTarget(t, true, saveType)).map(t => t.id);
    canvas.tokens.setTargets(tokenList);
    addTargets(savesMessage, saveType);
});

function addSavesMessageListeners(message: ChatMessagePF2e, html: HTMLElement) {
    const savesFlag = message.flags[MODULE_NAME] as SavesFlag;
    const tokenDocList = savesFlag.targets?.map(t => fromUuidSync(t) as TokenDocumentPF2e).filter(t => t);
    let button = htmlQuery(html, "[data-action='set-targets']");
    button?.addEventListener("click", (event) => addTargets(message, savesFlag.saveInfo?.saveType ?? ""));

    const incompleteRollTokenList: TokenDocumentPF2e[] = [];
    const incompleteRollNPCList: TokenDocumentPF2e[] = [];
    const tokenRows = htmlQueryAll(html, "[data-token]");

    for (let tokenRow of tokenRows) {
        if (tokenRow && tokenRow.dataset?.token) {
            const targetToken = fromUuidSync(tokenRow.dataset?.token) as TokenDocumentPF2e | null;
            const tokenName = htmlQuery(tokenRow, "[data-action='select-token']");

            if (tokenName && targetToken) {
                tokenName.addEventListener("mouseenter", (event) => targetToken.object?.emitHoverIn(event));
                tokenName.addEventListener("mouseleave", (event) => targetToken.object?.emitHoverOut(event));
                tokenName.addEventListener("click", (event) => {
                    if (targetToken.isOwner && targetToken.object) {
                        if (!targetToken.object.controlled || !event.shiftKey)
                            targetToken.object.control({ releaseOthers: !event.shiftKey });
                        else
                            targetToken.object.release();
                    }
                });

                let button = htmlQuery(tokenRow, "[data-action='roll-save-token']");
                if (button && targetToken.isOwner) {
                    incompleteRollTokenList.push(targetToken);
                    if (button.dataset.playerOwned === "npc")
                        incompleteRollNPCList.push(targetToken);
                    button.classList.remove("no-display");
                    button.addEventListener("click", (event) => rollSave(event, message.id, savesFlag, targetToken));
                }
            }
        }
    }

    button = htmlQuery(html, "[data-action='roll-saves-all']");
    button?.addEventListener("click", async (event) => Promise.all(incompleteRollTokenList.map(t => rollSave(event, message.id, savesFlag, t, game.settings.get(MODULE_NAME, SETTINGS.SKIP_MULTIPLE_ROLL_DIALOG) as boolean))));
    button = htmlQuery(html, "[data-action='roll-saves-npc']");
    button?.addEventListener("click", async (event) => Promise.all(incompleteRollNPCList.map(t => rollSave(event, message.id, savesFlag, t, game.settings.get(MODULE_NAME, SETTINGS.SKIP_MULTIPLE_ROLL_DIALOG) as boolean))));
}

async function rollSave(event: MouseEvent, messageId: string, savesFlag: SavesFlag, tokenDoc: TokenDocumentPF2e, forceSkipDialog: boolean = false) {
    event.stopPropagation();

    if (!savesFlag.saveInfo)
        return;

    const stat = tokenDoc.actor?.getStatistic(savesFlag.saveInfo.saveType);

    if (!stat)
        return;

    if (!savesFlag.origin)
        return;

    await stat.check.roll({
        item: await fromUuid(savesFlag.origin.uuid) as ItemPF2e<ActorPF2e> | null,
        origin: savesFlag.origin.actor ? await fromUuid(savesFlag.origin.actor) as ActorPF2e | null : undefined,
        dc: savesFlag.saveInfo.dc,
        token: tokenDoc,
        skipDialog: forceSkipDialog !== event.shiftKey,
        identifier: messageId,
        rollMode: tokenDoc.hidden ? "gmroll" : "roll",
        extraRollOptions: savesFlag.saveInfo.extraRollOptions,
        createMessage: !game.settings.get(MODULE_NAME, SETTINGS.HIDE_SAVING_THROWS),
        callback: async (roll, outcome, rollMessage, event) => onRollCallback(messageId, roll, rollMessage)
    });
}

Hooks.on("pf2e.reroll", (originalRoll: CheckRoll, reroll: CheckRoll, heroPoint: boolean, keep: string) => {
    if (reroll.options.type === "saving-throw" && reroll.options.identifier) {
        const savesMesage = game.messages.get(reroll.options.identifier);
        if (!savesMesage || !savesMesage.flags[MODULE_NAME]?.sourceMessage)
            return;
            
        Hooks.once("createChatMessage", (message: ChatMessagePF2e) => {
            if (message.rolls?.length <= 0)
                return;

            onRollCallback(savesMesage.id, reroll, message);
        });
    }
});

async function onRollCallback(savesMessageId: string, roll: CheckRoll, rollMessage: ChatMessagePF2e) {
    {
        if (!roll || roll.degreeOfSuccess == null || !roll.total)
            return;

        if (game.modules.get("dice-so-nice")?.active) {
            if (rollMessage)
                await game.dice3d?.waitFor3DAnimationByMessageID(rollMessage.id);
        }
        const context = rollMessage.flags[SYSTEM_ID].context as CheckContextChatFlag | undefined;
        const tokenUuid = context?.target?.token;

        if (!tokenUuid)
            return;

        const message = game.messages.get(savesMessageId);
        if (!message || !message.flags[MODULE_NAME])
            return;

        let savesFlag = message.flags[MODULE_NAME] as SavesFlag;

        if (message.isAuthor || game.user.isGM) {
            const resultEntry = { degreeOfSuccess: roll.degreeOfSuccess, rollValue: roll.total };
            savesFlag.results[uuidConvert(tokenUuid)] = resultEntry;
            ChatMessage.updateDocuments([{
                _id: message.id,
                [`flags.${MODULE_NAME}.results.${uuidConvert(tokenUuid)}`]: { degreeOfSuccess: roll.degreeOfSuccess, rollValue: roll.total } satisfies SaveResult,
                content: await getSavesMessageContent(savesFlag)
            }]);
        }
        else {
            game.socket.emit(SOCKET_NAME, {
                type: "save-rolled",
                message: savesMessageId,
                token: tokenUuid,
                degreeOfSuccess: roll.degreeOfSuccess,
                rollValue: roll.total
            } satisfies SaveRolledMessage);
        }
    }
}

function filterTarget(target: TokenPF2e, ignoreDead: boolean, saveStatistic: string | undefined = undefined): boolean {
    if (!target.actor)
        return false;
    if (saveStatistic && !target.actor?.getStatistic(saveStatistic))
        return false;
    if (!target.actor.isOfType("creature", "hazard", "vehicle"))
        return false;
    if (ignoreDead && target.actor.isDead)
        return false;

    return true;
}

async function addTargets(message: ChatMessagePF2e, saveStatistic: string) {
    const targets = game.user.targets.filter(t => filterTarget(t, false, saveStatistic)).map(t => t.document.uuid);
    const savesFlag = message.flags[MODULE_NAME] as SavesFlag;
    savesFlag.targets = [...targets];
    await message.update({ [`flags.${MODULE_NAME}.targets`]: savesFlag.targets, content: await getSavesMessageContent(savesFlag) });
}

async function findSavesMessageFromDamageRoll(message: ChatMessagePF2e): Promise<ChatMessagePF2e | null> {
    let origin = message.flags[SYSTEM_ID].origin;
    if (!origin || !origin.uuid || !APPLICABLE_MESSAGE_TYPES.includes(origin.type as ApplicableMessageType))
        return null;

    const itemUuid = origin.uuid;

    const messageFound = game.messages.contents.findLast(m => (m.flags[MODULE_NAME] as SavesFlag)?.origin?.uuid === itemUuid);

    if (!messageFound || messageFound.flags[MODULE_NAME]?.damageMessage)
        return null;

    await messageFound.update({ [`flags.${MODULE_NAME}.damageMessage`]: message.id });
    return messageFound;
}

async function onDamageMessageCreated(message: ChatMessagePF2e) {
    const savesMessage = await findSavesMessageFromDamageRoll(message);

    let flagUpdate = {} as Record<string, unknown>;
    if (savesMessage) {
        flagUpdate.savesMessage = savesMessage.id;
    }
    else {
        flagUpdate.targets = [...game.user.targets.filter(t => filterTarget(t, false)).map(t => t.document.uuid)];
    }

    await message.update({ [`flags.${MODULE_NAME}`]: flagUpdate });
}

interface HealingTraits {
    traitVitality: boolean,
    traitVoid: boolean,
    traitSpirit: boolean,
    traitMental: boolean
}

function getHealingTraitsFromOptions(options: string[] | undefined): HealingTraits {
    let result = { traitVitality: false, traitVoid: false, traitSpirit: false, traitMental: false } as HealingTraits;
    if (!options)
        return result;

    options.forEach(t => {
        switch (t) {
            case "vitality":
                result.traitVitality = true; break;
            case "void":
                result.traitVoid = true; break;
            case "spirit":
                result.traitSpirit = true; break;
            case "mental":
                result.traitMental = true; break;
        }
    });

    return result;
}

function canApplyHealing(actor: ActorPF2e | null, healingTraits: HealingTraits | undefined): boolean {
    if (!actor || !healingTraits)
        return false;
    if (healingTraits.traitVitality && actor.modeOfBeing === "living")
        return true;
    if (healingTraits.traitVoid && actor.modeOfBeing === "undead")
        return true;
    if (healingTraits.traitSpirit && actor.modeOfBeing !== "construct" && actor.modeOfBeing !== "object")
        return true;
    if (healingTraits.traitMental && !actor.traits.has("mindless"))
        return true;
    return false;
}

async function applyDamageToAll(message: ChatMessagePF2e, tokenDocList: TokenDocumentPF2e[], savesFlag: SavesFlag, rollIndex: number) {
    if (tokenDocList.length == 0)
        return;

    let allResult: Promise<void>[] = [];
    let messageUpdate: Record<string, unknown> = {};
    let doUpdate = false;
    const roll = message.rolls[rollIndex] as Rolled<DamageRoll>;

    const hasHealing = roll.kinds.has("healing");

    const options = message.flags[SYSTEM_ID]?.origin?.rollOptions;

    const healingTraits = getHealingTraitsFromOptions(hasHealing ? options : undefined);
    
    for (let token of tokenDocList) {
        
        let uuidConverted = uuidConvert(token.uuid);
        const saveResult = savesFlag.results[uuidConverted];
        let doHeal = game.settings.get(MODULE_NAME, SETTINGS.APPLY_HEALING) && hasHealing && canApplyHealing(token.actor, healingTraits);
        if (!saveResult && !doHeal)
            continue;

        const degreeOfSuccess = saveResult?.degreeOfSuccess ?? "success";
        messageUpdate[`flags.${MODULE_NAME}.applied.${uuidConverted}`] = true;
        doUpdate = true;

        let multiplier = 0;

        if (doHeal)
            multiplier = -1;
        else {
            switch (saveResult.degreeOfSuccess) {
                case 0:
                    multiplier = 2;
                    break;
                case 1:
                    multiplier = 1;
                    break;
                case 2:
                    multiplier = 0.5;
                    break;
                case 3:
                    multiplier = 0;
                    break;
            }
        }

        if (multiplier == 0)
            continue;

        allResult.push(applyDamage(message, multiplier, 0, rollIndex, token, false, DEGREE_OF_SUCCESS_STRINGS[degreeOfSuccess], false));
    }

    await Promise.all(allResult);
    if (doUpdate)
        await message.update(messageUpdate);
}

function renderDamageAllButtons(message: ChatMessagePF2e, tokenDocList: TokenDocumentPF2e[], savesFlag: SavesFlag, rollIndex: number): HTMLElement {
    let buttonContainer = createHTMLElement("div", { classes: ["saves-buttons"] });

    const applieds = message.flags[MODULE_NAME]?.applied as Record<string, unknown> | undefined;

    const unappliedDamageTokenList = applieds ? tokenDocList.filter(t => !applieds[uuidConvert(t.uuid)]) : tokenDocList;

    let rollAll = createHTMLElement("a", { innerHTML: '<i class="fa-solid fa-users"></i>', dataset: { tooltip: game.i18n.localize("PF2E-SAVES-HELPER.ApplyAll") } });
    rollAll.addEventListener("click", async (event) => await applyDamageToAll(message, unappliedDamageTokenList, savesFlag, rollIndex));
    buttonContainer.append(rollAll);
    let rollNPCs = createHTMLElement("a", { innerHTML: '<i class="fa-solid fa-users-cog"></i>', dataset: { tooltip: game.i18n.localize("PF2E-SAVES-HELPER.ApplyNPC") } });
    rollNPCs.addEventListener("click", async (event) => await applyDamageToAll(message, unappliedDamageTokenList.filter(t => !t.hasPlayerOwner), savesFlag, rollIndex));
    buttonContainer.append(rollNPCs);
    return buttonContainer;
}

function onRenderDamageMessage(message: ChatMessagePF2e, html: HTMLElement) {
    if (!message.flags[MODULE_NAME])
        return;

    const savesMessage = message.flags[MODULE_NAME].savesMessage ? game.messages.get(message.flags[MODULE_NAME].savesMessage as string) : undefined;
    const savesFlag = savesMessage?.flags[MODULE_NAME] as SavesFlag | undefined;

    const targets = savesFlag ? savesFlag.targets : message.flags[MODULE_NAME].targets as string[] | undefined;
    if (!targets || targets.length == 0)
        return;

    const healingTraits = game.settings.get(MODULE_NAME, SETTINGS.APPLY_HEALING) ? getHealingTraitsFromOptions(message.flags[SYSTEM_ID].origin?.rollOptions) : undefined;

    const tokenDocList = targets.map(t => fromUuidSync(t) as TokenDocumentPF2e).filter(t => t && t.isOwner);

    const damageApplicationList = htmlQueryAll(html, "section.damage-application");

    damageApplicationList.forEach((damageApplication, index) => {
        let damageTokenContainer = createHTMLElement("section", { classes: ["pf2e-saves-helper", "damage-token"] });
        const isHealingRoll = (message.rolls[index] as Rolled<DamageRoll>).kinds.has("healing");
        const splash = message.rolls[index]?.options.splashOnly as boolean | undefined ?? false;

        let gmButtons: HTMLElement | undefined = undefined;
        if (game.user.isGM && savesFlag?.saveInfo?.basic && tokenDocList.length > 0) {
            gmButtons = renderDamageAllButtons(message, tokenDocList, savesFlag, index);
        }

        for (let token of tokenDocList) {
            const highlightHeal = isHealingRoll && canApplyHealing(token.actor, healingTraits);

            let tokenSection = createHTMLElement("div", { classes: ["damage-application"] });
            if (message.flags[MODULE_NAME]?.applied) {
                const applieds = message.flags[MODULE_NAME]?.applied as Record<string, unknown>
                if (applieds[uuidConvert(token.uuid)])
                    tokenSection.classList.add("already-applied");
            }

            let degreeOfSuccess: ZeroToThree | undefined = undefined;

            damageTokenContainer.append(createHTMLElement("hr"));

            let tokenHeader = createHTMLElement("header", { innerHTML: token.name });
            tokenHeader.addEventListener("mouseenter", (event) => token.object?.emitHoverIn(event));
            tokenHeader.addEventListener("mouseleave", (event) => token.object?.emitHoverOut(event));
            
            if (savesFlag)
                degreeOfSuccess = savesFlag.results?.[uuidConvert(token.uuid)]?.degreeOfSuccess;

            if (degreeOfSuccess != undefined)
                tokenHeader.classList.add(DEGREE_OF_SUCCESS_STRINGS[degreeOfSuccess]);

            damageTokenContainer.append(tokenHeader);

            let shieldBlockButton: HTMLButtonElement | undefined = undefined;
            if (htmlQuery(damageApplication, "button[data-action='shieldBlock']")) {
                shieldBlockButton = createHTMLElement("button", { dataset: { action: "shieldBlock" }, classes: ["dice-total-shield-btn", "tooltipstered"], innerHTML: `<span class="label">${game.i18n.localize("PF2E.DamageButton.ShieldBlockShort")}</<span>` });
                if (shieldBlockButton) {
                    shieldBlockButton.type = "button";
                    shieldBlockButton.addEventListener("click", (event) => {
                        if (shieldBlockButton) {
                            if (shieldBlockButton.classList.contains("shield-activated"))
                                shieldBlockButton.classList.remove("shield-activated");
                            else
                                shieldBlockButton.classList.add("shield-activated");
                        }
                    });
                }
            }

            let hasDamageButton = false;

            if (htmlQuery(damageApplication, "button[data-multiplier='1']")) {
                hasDamageButton = true;

                let damageButton = createHTMLElement("button", { innerHTML: `<span class="label">${game.i18n.localize(splash ? "PF2E.TraitSplash" : "PF2E.DamageButton.FullShort")}</<span>` });
                damageButton.type = "button";
                if (!highlightHeal && savesFlag && savesFlag.saveInfo?.basic && degreeOfSuccess == DEGREE_OF_SUCCESS.FAILURE)
                    damageButton.classList.add("highlighted");
                damageButton.addEventListener("click", (event) => { onClickDamageButton(message, 1, index, token, shieldBlockButton, degreeOfSuccess ? DEGREE_OF_SUCCESS_STRINGS[degreeOfSuccess] : "success"); });
                tokenSection.append(damageButton);
            }

            if (htmlQuery(damageApplication, "button[data-multiplier='0.5']")) {
                let halfButton = createHTMLElement("button", { classes: ["half-damage"], innerHTML: `<span class="label">${game.i18n.localize("PF2E.DamageButton.HalfShort")}</<span>` });
                halfButton.type = "button";
                if (!highlightHeal && savesFlag && savesFlag.saveInfo?.basic && degreeOfSuccess == DEGREE_OF_SUCCESS.SUCCESS)
                    halfButton.classList.add("highlighted");
                halfButton.addEventListener("click", (event) => { onClickDamageButton(message, 0.5, index, token, shieldBlockButton, degreeOfSuccess ? DEGREE_OF_SUCCESS_STRINGS[degreeOfSuccess] : "success"); });
                tokenSection.append(halfButton);
            }

            if (htmlQuery(damageApplication, "button[data-multiplier='2']")) {
                let doubleButton = createHTMLElement("button", { innerHTML: `<span class="label">${game.i18n.localize("PF2E.DamageButton.DoubleShort")}</<span>` });
                doubleButton.type = "button";
                if (!highlightHeal && savesFlag && savesFlag.saveInfo?.basic && degreeOfSuccess == DEGREE_OF_SUCCESS.CRITICAL_FAILURE)
                    doubleButton.classList.add("highlighted");
                doubleButton.addEventListener("click", (event) => { onClickDamageButton(message, 2, index, token, shieldBlockButton, degreeOfSuccess ? DEGREE_OF_SUCCESS_STRINGS[degreeOfSuccess] : "success"); });
                tokenSection.append(doubleButton);
            }

            if (htmlQuery(damageApplication, "button[data-multiplier='3']")) {
                let tripleButton = createHTMLElement("button", { innerHTML: `<span class="label">${game.i18n.localize("PF2E.DamageButton.TripleShort")}</<span>` });
                tripleButton.type = "button";
                tripleButton.addEventListener("click", (event) => { onClickDamageButton(message, 3, index, token, shieldBlockButton, degreeOfSuccess ? DEGREE_OF_SUCCESS_STRINGS[degreeOfSuccess] : "success"); });
                tokenSection.append(tripleButton);
            }

            if (shieldBlockButton)
                tokenSection.append(shieldBlockButton);

            if (htmlQuery(damageApplication, "button[data-multiplier='-1']")) {
                let healingButton = createHTMLElement("button", { innerHTML: `<span class="label">${game.i18n.localize(hasDamageButton ? "PF2E.DamageButton.HealingShort" : "PF2E.Damage.Kind.Healing.Apply.Label")} </<span>` });
                healingButton.type = "button";
                if (highlightHeal)
                    healingButton.classList.add("highlighted");
                healingButton.addEventListener("click", (event) => { onClickDamageButton(message, -1, index, token, undefined, degreeOfSuccess ? DEGREE_OF_SUCCESS_STRINGS[degreeOfSuccess] : "success"); });
                tokenSection.append(healingButton);
            }

            damageTokenContainer.append(tokenSection);

            if (splash) {
                let splashAroundDiv = createHTMLElement("div", { classes: ["damage-application"] });
                let damageButton = createHTMLElement("button", { innerHTML: `<span class="label">${game.i18n.localize("PF2E-SAVES-HELPER.SplashAround")}</<span>` });
                damageButton.type = "button";
                damageButton.addEventListener("click", (event) => { onClickSplashAround(message, index, token) });
                splashAroundDiv.append(damageButton);
                damageTokenContainer.append(splashAroundDiv);
            }
        }
        damageApplication.after(damageTokenContainer);
        if (gmButtons)
            damageApplication.after(gmButtons);
    });
}

async function onClickDamageButton(message: ChatMessagePF2e, multiplier: number, rollIndex: number = 0, token: TokenDocumentPF2e, shieldBlockButton: HTMLElement | undefined, outcome: DegreeOfSuccessString) {

    const shieldBlock = shieldBlockButton?.classList.contains("shield-activated") ?? false;
    let addend = 0;
    applyDamage(message, multiplier, addend, rollIndex, token, shieldBlock, outcome);
    if (shieldBlockButton && shieldBlock)
        shieldBlockButton.classList.remove("shield-activated");
}

async function onClickSplashAround(message: ChatMessagePF2e, rollIndex: number = 0, token: TokenDocumentPF2e) {
    const tokenObject = token.object;
    if (!tokenObject) {
        ui.notifications.error("Token not found in scene!");
        return;
    }
    const radius = 5;
    const radiusGrid = radius * canvas.grid.size / canvas.dimensions.distance;
    const center = tokenObject.center;
    const foundTokens = canvas.tokens.quadtree.getObjects(new PIXI.Rectangle(tokenObject.x - radiusGrid, tokenObject.y - radiusGrid, tokenObject.w + radiusGrid, tokenObject.h + radiusGrid));
    for (let foundToken of foundTokens) {
        if (foundToken.id === tokenObject.id)
            continue;

        if (tokenObject.distanceTo(foundToken) > radius)
            continue;

        const hasCollision = CONFIG.Canvas.polygonBackends.move.testCollision(
            center,
            foundToken.center,
            {
                type: "move",
                mode: "any",
            }
        );

        if (hasCollision)
            continue;

        applyDamage(message, 1, 0, rollIndex, foundToken.document, false, DEGREE_OF_SUCCESS_STRINGS[DEGREE_OF_SUCCESS.SUCCESS], false);
    }
}

async function applyDamage(message: ChatMessagePF2e,
    multiplier = 1,
    addend = 0,
    rollIndex = 0,
    token: TokenDocumentPF2e,
    shieldBlockRequest: boolean,
    outcome: DegreeOfSuccessString,
    updateMessageApplied = true) {
    applyDamageFromMessage(message, multiplier, addend, rollIndex, token, shieldBlockRequest, outcome, updateMessageApplied);
}

async function applyDamageFromMessage(
    message: ChatMessagePF2e,
    multiplier = 1,
    addend = 0,
    rollIndex = 0,
    token: TokenDocumentPF2e,
    shieldBlockRequest: boolean,
    outcome: DegreeOfSuccessString,
    updateMessageApplied = true

): Promise<void> {
    const roll = message.rolls.at(rollIndex);
    if (!roll) return;

    const damage = multiplier < 0 ? multiplier * roll.total + addend : roll.alter(multiplier, addend) as Rolled<DamageRoll>;

    // Get origin roll options and apply damage to a contextual clone: this may influence condition IWR, for example
    const messageRollOptions = [...(message.flags[SYSTEM_ID].context?.options ?? [])];
    const originRollOptions = messageRollOptions
        .filter((o) => o.startsWith("self:"))
        .map((o) => o.replace(/^self/, "origin"));
    const messageItem = message.item;
    const effectRollOptions = messageItem?.isOfType("affliction", "condition", "effect")
        ? messageItem.getRollOptions("item")
        : [];

    if (!token.actor) return;
    // Add roll option for ally/enemy status
    if (token.actor.alliance && message.actor) {
        const allyOrEnemy = token.actor.alliance === message.actor.alliance ? "ally" : "enemy";
        messageRollOptions.push(`origin:${allyOrEnemy}`);
    }

    // If no target was acquired during a roll, set roll options for it during damage application
    if (!messageRollOptions.some((o) => o.startsWith("target"))) {
        messageRollOptions.push(...token.actor.getSelfRollOptions("target"));
    }
    const domain = multiplier > 0 ? "damage-received" : "healing-received";
    const ephemeralEffects =
        multiplier > 0
            ? await extractEphemeralEffects({
                affects: "target",
                origin: message.actor,
                target: token.actor,
                item: message.item,
                domains: [domain],
                options: messageRollOptions,
            })
            : [];
    const contextClone = token.actor.getContextualClone(originRollOptions, ephemeralEffects);
    const rollOptions = new Set([
        ...messageRollOptions.filter((o) => !/^(?:self|target)(?::|$)/.test(o)),
        ...effectRollOptions,
        ...originRollOptions,
        ...contextClone.getSelfRollOptions(),
    ]);

    const result = await contextClone.applyDamage({
        damage,
        token,
        item: message.item,
        skipIWR: multiplier <= 0,
        rollOptions,
        shieldBlockRequest,
        outcome: outcome,
    });

    if (result && updateMessageApplied) {
        if (game.user.isGM || message.isAuthor)
            await updateAppliedToken(message, token.uuid);
        else
            game.socket.emit(SOCKET_NAME, {
                type: "update-applied",
                message: message.id,
                token: token.uuid
            } satisfies UpdateAppliedMessage)
    }
}

function getTemplateTokens(measuredTemplate: MeasuredTemplateDocumentPF2e | MeasuredTemplatePF2e) {
    const grid = canvas.interface.grid;
    const dimensions = canvas.dimensions;
    const template =
        measuredTemplate instanceof MeasuredTemplateDocument
            ? measuredTemplate.object
            : measuredTemplate;
    if (!canvas.scene || !template?.highlightId || !grid || !dimensions) return [];

    const gridHighlight = grid.getHighlightLayer(template.highlightId);
    if (!gridHighlight || canvas.grid.type !== CONST.GRID_TYPES.SQUARE) return [];

    const gridSize = canvas.grid.size;
    const containedTokens: TokenPF2e[] = [];
    const origin = template.center;
    const tokens = canvas.tokens.quadtree.getObjects(
        gridHighlight.getLocalBounds(undefined, true)
    ) as Set<TokenPF2e>;

    for (const token of tokens) {
        const tokenDoc = token.document;
        const tokenPositions = [];

        for (let h = 0; h < tokenDoc.height; h++) {
            const tokenX = Math.floor(token.center.x / gridSize) * gridSize;
            const tokenY = Math.floor(token.center.y / gridSize) * gridSize;
            const y = tokenY + h * gridSize;

            tokenPositions.push(`${tokenX},${y}`);

            if (tokenDoc.width > 1) {
                for (let w = 1; w < tokenDoc.width; w++) {
                    tokenPositions.push(`${tokenX + w * gridSize},${y}`);
                }
            }
        }

        for (const position of tokenPositions) {
            if (!gridHighlight.positions.has(position)) {
                continue;
            }

            const [gx, gy] = position.split(",").map((s) => Number(s));
            const destination = {
                x: gx + dimensions.size * 0.5,
                y: gy + dimensions.size * 0.5,
            };
            if (destination.x < 0 || destination.y < 0) continue;

            const hasCollision = CONFIG.Canvas.polygonBackends.move.testCollision(
                origin,
                destination,
                {
                    type: "move",
                    mode: "any",
                }
            );

            if (!hasCollision) {
                containedTokens.push(token);
                break;
            }
        }
    }

    return containedTokens;
}
