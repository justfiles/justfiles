export interface ReaderCapability {
	read(input: { url: string }): Promise<{
		url: string
		title: string
		markdown: string
		siteName?: string
		byline?: string
		publishedAt?: number
		wordCount: number
	}>
	open(input: { url: string }): Promise<void>
}
