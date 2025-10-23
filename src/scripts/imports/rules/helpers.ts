import * as R from "remeda";
import { ActorPF2e, ConditionSource, EffectSource, ItemPF2e } from "foundry-pf2e";

interface ExtractEphemeralEffectsParams {
    affects: "target" | "origin";
    origin: ActorPF2e | null;
    target: ActorPF2e | null;
    item: ItemPF2e | null;
    domains: string[];
    options: Set<string> | string[];
}

async function extractEphemeralEffects({
    affects,
    origin,
    target,
    item,
    domains,
    options,
}: ExtractEphemeralEffectsParams): Promise<(ConditionSource | EffectSource)[]> {
    if (!(origin && target)) return [];

    const [effectsFrom, effectsTo] = affects === "target" ? [origin, target] : [target, origin];
    const fullOptions = [...options, effectsFrom.getRollOptions(domains), effectsTo.getSelfRollOptions(affects)].flat();
    const resolvables = item ? (item.isOfType("spell") ? { spell: item } : { weapon: item }) : {};
    return (
        await Promise.all(
            domains
                .flatMap((s) => effectsFrom.synthetics.ephemeralEffects[s]?.[affects] ?? [])
                .map((d) => d({ test: fullOptions, resolvables })),
        )
    )
        .filter(R.isNonNull)
        .map((effect) => {
            if (effect.type === "effect") {
                effect.system.context = {
                    origin: {
                        actor: effectsFrom.uuid,
                        token: null,
                        item: null,
                        spellcasting: null,
                        rollOptions: [],
                    },
                    target: { actor: effectsTo.uuid, token: null },
                    roll: null,
                };
                effect.system.duration = { value: -1, unit: "unlimited", expiry: null, sustained: false };
            }
            return effect;
        });
}

export { extractEphemeralEffects };