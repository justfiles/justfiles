import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// Mirrors wrangler's text rule for *.sql so Vite handles them the same way
const sqlTextPlugin = {
	name: "sql-text",
	transform(code: string, id: string) {
		if (id.endsWith(".sql")) {
			return `export default ${JSON.stringify(code)}`
		}
	},
}

export default defineConfig({
	plugins: [sqlTextPlugin, react(), cloudflare()],
});
