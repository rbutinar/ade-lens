/**
 * The composition point of this deployment (lib/lens/plane-contract.ts says why there is one).
 *
 * Self-host: Power BI is reached as the signed-in user (OBO) and nothing else is added. To wire
 * something around the core — a closed set of reports, your own sign-in, usage caps — implement
 * `LensPlane` here and keep the rest of the code as it is.
 */
export { selfHostPlane as plane } from "@/lib/lens/plane-contract";
