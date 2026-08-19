import { storeConformance } from './conformance'
import { memStore } from './mem'

storeConformance('memStore', async () => memStore())
