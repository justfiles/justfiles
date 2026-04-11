export { Frieren } from "./frieren.ts";


export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// WebSocket upgrade → route to Durable Object
		if (url.pathname === "/ws") {
			const id = env.FRIEREN.idFromName("default");
			const stub = env.FRIEREN.get(id);
			return stub.fetch(request);
		}

		// REST API routes
		if (url.pathname.startsWith("/api/")) {
			return Response.json({ name: "Frieren" });
		}

		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
