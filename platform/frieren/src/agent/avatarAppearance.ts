import { type Avatar, type CanvasSkin, gameboyAvatar, type ImageSkin } from '@justfiles/avatar'

export type AvatarAppearance = Avatar<ImageSkin> | Avatar<CanvasSkin>

export const GAMEBOY_AVATAR = gameboyAvatar satisfies AvatarAppearance
