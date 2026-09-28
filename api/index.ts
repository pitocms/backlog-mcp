// Vercel serverless entrypoint. vercel.json rewrites every path to this
// function; the Express app routes /mcp and /health as usual.
import { app } from "../src/app.js";

export default app;
