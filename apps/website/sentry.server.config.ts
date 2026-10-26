import handler from "@astrojs/cloudflare/entrypoints/server";
import { monitored } from "./src/monitoring.worker";

export default monitored(handler);
