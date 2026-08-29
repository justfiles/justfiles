# `@justfiles/avatar`

Avatar rendering is split into two parts. A renderer owns an element and its lifecycle. A skin
supplies the renderer-specific art or drawing function.

```ts
import { gameboyAvatar, mountAvatar } from '@justfiles/avatar'

const avatar = mountAvatar(host, gameboyAvatar, { expression: null })
avatar.update({ expression: 'pleased' })
avatar.destroy()
```

The package ships Image and Canvas renderers. Game Boy is the first Canvas skin. React consumers can
use the generic `Avatar` or the ready-made `GameboyAvatar` from `@justfiles/avatar/react`.
