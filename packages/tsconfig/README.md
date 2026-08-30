# @justfiles/tsconfig

Shared TypeScript configurations for JustFiles packages.

```json
{
	"extends": "@justfiles/tsconfig/dom.json",
	"include": ["src"]
}
```

- `base.json` has the strict settings shared by every package.
- `dom.json` adds browser libraries, JSX, and Vite types.
- `library.json` emits declarations and JavaScript into `dist`.
