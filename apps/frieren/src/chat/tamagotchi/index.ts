// Standalone pixel-art tamagotchi scene. Pure canvas 2D, zero deps, no React.
//
//   const scene = createTamagotchi({ canvas })
//   scene.setMode('listen'); scene.setEmotion('happy'); scene.poke()
//   scene.destroy()
//
// Features: procgen landscape (1D value noise + fbm), parallax hill bands,
// y-depth scaling, y-sorted props + character, contact shadows, biome palettes.
// Character skins live in ./character.ts; prop helpers live in ./sprites.ts.

export type { CharacterActivity, CharacterEmotion, CharacterReaction } from './character'
export { DEFAULT_SKIN_ID, getSkin, getSkinAvatarUrl, listSkinIds } from './character'
export type { Biome } from './palettes'
export type { SceneMode, TamagotchiHandle, TamagotchiOptions } from './scene'
export { createTamagotchi } from './scene'
