import { decodeEventLog, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { PULSE_MINT_ABI, PULSE_PAID_SLOT } from "../pulseAuthorization.js";
import { GENERATIVE_MINT_ABI } from "../generativeAuthorization.js";
import type { PulseDeploymentPin } from "../pulseEconomics.js";
import type { normalizeProjectionLog } from "./decode.js";

export const PULSE_ECONOMIC_TOPICS = Object.freeze([
  encodeEventTopics({abi:PULSE_MINT_ABI,eventName:"MintEconomics"})[0],
  encodeEventTopics({abi:PULSE_MINT_ABI,eventName:"Sale"})[0],
  encodeEventTopics({abi:PULSE_MINT_ABI,eventName:"PaidPhaseStarted"})[0],
]);
export const PULSE_TOPIC_COUNTS = Object.freeze({[PULSE_ECONOMIC_TOPICS[0]]:4,[PULSE_ECONOMIC_TOPICS[1]]:3,[PULSE_ECONOMIC_TOPICS[2]]:1});
export interface ProjectedPulseEconomics {
  readonly mintMode: 0|1; readonly slotId: string; readonly price: string; readonly maxPrice: string;
  readonly epochIndex: string; readonly saleConfigHash: Hex;
}
type Log = ReturnType<typeof normalizeProjectionLog>;
const fail = (): never => { throw new Error("Pulse mint economics/event evidence failed validation."); };
/** Receipts authenticate these logs in the outer observer. Require one economics
 * record per mint and one Sale per paid mint; never infer prices from previews. */
export function decodePulseEconomics(logs: readonly Log[], pin: PulseDeploymentPin, timestamp: string) {
  const results = new Map<string, ProjectedPulseEconomics>();
  const mintTopic=encodeEventTopics({abi:GENERATIVE_MINT_ABI,eventName:"GenerativeSignatureMinted"})[0];
  const mints=logs.filter(l => l.topics[0] === mintTopic);
  const economics=logs.filter(l => l.topics[0] === PULSE_ECONOMIC_TOPICS[0]);
  const sales=logs.filter(l => l.topics[0] === PULSE_ECONOMIC_TOPICS[1]);
  if(economics.length !== mints.length || sales.length > 1) fail();
  let paid=0;
  for(const log of economics) {
    const event=decodeEventLog({abi:PULSE_MINT_ABI,eventName:"MintEconomics",topics:log.topics as [Hex,...Hex[]],data:log.data,strict:true}), a=event.args;
    if(encodeEventTopics({abi:PULSE_MINT_ABI,eventName:"MintEconomics",args:a}).join() !== log.topics.join()
      || encodeAbiParameters([{type:"uint8"},{type:"uint256"},{type:"uint256"},{type:"uint64"}],[a.mintMode,a.price,a.maxPrice,a.epochIndex]) !== log.data) fail();
    const matches=mints.filter(m => m.transactionHash === log.transactionHash && m.topics[1] === `0x${a.tokenId.toString(16).padStart(64,"0")}` && m.topics[2] === a.nonce);
    if(matches.length !== 1) fail();
    const mint=decodeEventLog({abi:GENERATIVE_MINT_ABI,eventName:"GenerativeSignatureMinted",topics:matches[0].topics as [Hex,...Hex[]],data:matches[0].data,strict:true});
    const key=`${log.transactionHash}:${a.nonce}`;
    if(results.has(key) || (a.mintMode !== 0 && a.mintMode !== 1)) fail();
    if(a.mintMode === 0) {
      if(a.slotId >= BigInt(pin.slotCount) || a.maxPrice !== 0n || a.price !== 0n || a.epochIndex !== 0n || BigInt(timestamp) >= BigInt(pin.freeDeadline)) fail();
    } else {
      paid++;
      if(a.slotId !== PULSE_PAID_SLOT || a.price > a.maxPrice || a.epochIndex === 0n) fail();
      const matching=sales.filter(s => s.transactionHash === log.transactionHash);
      if(matching.length !== 1) fail();
      const sale=decodeEventLog({abi:PULSE_MINT_ABI,eventName:"Sale",topics:matching[0].topics as [Hex,...Hex[]],data:matching[0].data,strict:true}), s=sale.args;
      if(s.buyer.toLowerCase() !== mint.args.recipient.toLowerCase() || s.epochIndex !== a.epochIndex || s.price !== a.price || s.timestamp !== BigInt(timestamp)
        || encodeEventTopics({abi:PULSE_MINT_ABI,eventName:"Sale",args:s}).join() !== matching[0].topics.join()
        || encodeAbiParameters([{type:"uint256"},{type:"uint64"},{type:"uint64"},{type:"uint256"}],[s.price,s.timestamp,s.nextAnchorA,s.nextFloorB]) !== matching[0].data) fail();
    }
    results.set(key,Object.freeze({mintMode:a.mintMode as 0|1,slotId:a.slotId.toString(),price:a.price.toString(),maxPrice:a.maxPrice.toString(),epochIndex:a.epochIndex.toString(),saleConfigHash:pin.saleConfigHash}));
  }
  if(paid !== sales.length) fail();
  const transitions=logs.filter(l => l.topics[0] === PULSE_ECONOMIC_TOPICS[2]);
  if(transitions.length > 1) fail();
  for(const log of transitions) {
    const e=decodeEventLog({abi:PULSE_MINT_ABI,eventName:"PaidPhaseStarted",topics:log.topics as [Hex,...Hex[]],data:log.data,strict:true}), a=e.args;
    if(encodeAbiParameters([{type:"uint64"},{type:"uint8"},{type:"uint256"}],[a.startTime,a.reason,a.freeMinted]) !== log.data
      || !mints.some(m => m.transactionHash === log.transactionHash)
      || a.startTime > BigInt(timestamp) || a.freeMinted > BigInt(pin.slotCount)
      || (a.reason === 1 ? a.freeMinted !== BigInt(pin.slotCount) || a.startTime !== BigInt(timestamp)
        : a.reason !== 2 || a.startTime !== BigInt(pin.freeDeadline) || a.freeMinted >= BigInt(pin.slotCount))) fail();
  }
  return results;
}
