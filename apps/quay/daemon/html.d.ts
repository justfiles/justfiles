// bun-types globally declares `*.html` as an `HTMLBundle` (its fullstack HTML
// loader). We import HTML with `type: 'text'`, which yields the raw string, so we
// override the type for our one HTML import. TypeScript resolves an import to the
// matching wildcard with the longest literal prefix (the part before `*`); bun's
// `*.html` has an empty prefix, so this `./test.htm*` pattern (prefix `./test.htm`)
// wins for `./test.html`.
declare module './test.htm*' {
	const html: string
	export default html
}
