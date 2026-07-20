import { defineCapability } from '../core.ts'
import type { ImageCapability } from './contract.ts'

export { GENERATED_IMAGES_DIR, type ImageRef, imageAgentTools } from './agent.ts'
export type { GeneratedImage, ImageCapability } from './contract.ts'

export const image = defineCapability<'image', ImageCapability>('image')
