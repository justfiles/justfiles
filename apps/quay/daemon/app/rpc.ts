import type { Kernel } from '@justfiles/app'
import { RpcTarget } from 'capnweb'

type Emit = (value: unknown) => unknown

export class AppRpcTarget extends RpcTarget {
	constructor(
		private kernel: Kernel,
		private id: string
	) {
		super()
	}

	state() {
		return this.kernel.state(this.id)
	}

	dispatch(message: unknown) {
		return this.kernel.dispatch(this.id, message as never)
	}

	subscribe(onState: Emit) {
		this.kernel.subscribe((event) => {
			if (event.type === 'app.update' && event.appId === this.id) onState(event.state)
		})
	}
}
