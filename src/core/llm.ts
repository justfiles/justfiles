type ExpandedQuery = {
	semantic: string[] // 3 variants, for semantic (vector) search
	keywordSets: string[][] // 3 sets, 3-5 keywords each, for lexical/FTS match
}

type Metadata = {
	title: string
	tags: string[]
	category: string // hint for the path
}

export interface LLM {
	expand(query: string): Promise<ExpandedQuery>
	generateMetadata(content: string): Promise<Metadata>
}
