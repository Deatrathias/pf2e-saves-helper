import Game from "@7h3laughingman/foundry-types/client/game.mjs";

interface Dice3D {
    waitFor3DAnimationByMessageID(targetMessageId: string): Promise<boolean>;
}

export interface GameDSN extends Game {
    dice3d?: Dice3D;
}

export interface ChatMessageDSN extends ChatMessage {
    _dice3danimating?: boolean
}

export {};