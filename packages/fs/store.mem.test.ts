import { storeConformance } from './store.conformance'
import { memStore } from './store.mem'

storeConformance('memStore', async () => memStore())
