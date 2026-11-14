/**
 * Entry point for the hosted seller service behind the Try it page.
 * Built into one file with `npm run build:shop` and run on the server by
 * scripts/deploy-vps.sh. Reads the sellers' keys from ALMONER_SELLERS_FILE.
 */
import { startSellers } from "./sellers.js";

startSellers();
