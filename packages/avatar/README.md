# `@justfiles/avatar`

An avatar owns both ways it can be used: mount it for live animation, or render a still RGBA image.

```ts
import { gameboyAvatar } from '@justfiles/avatar'

const mounted = gameboyAvatar.mount(host)
mounted.update({ expression: 'pleased' })
mounted.destroy()

const image = gameboyAvatar.render({ expression: 'pleased' })
// image: { width, height, data: Uint8Array RGBA }
```

Use `avatar(...)` to define another Canvas avatar with the same two capabilities. React consumers
can use the generic `Avatar` or the ready-made `GameboyAvatar` from `@justfiles/avatar/react`.
