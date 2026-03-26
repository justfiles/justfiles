type ExpandedQuery = {
	lex: string // keyword query for FTS — stop words stripped, optimised for BM25
	semantic: string[] // 2-3 variants for vector search
	hyde: string // hypothetical document embedding — short paragraph answering the query
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
