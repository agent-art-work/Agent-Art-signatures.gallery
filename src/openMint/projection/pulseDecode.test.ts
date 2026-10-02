import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { GENERATIVE_MINT_ABI } from "../generativeAuthorization.js";
import { PULSE_MINT_ABI, PULSE_PAID_SLOT } from "../pulseAuthorization.js";
import { pulseFixturePin } from "../fixtures/pulse.js";
import { decodePulseEconomics } from "./pulseDecode.js";
import type { normalizeProjectionLog } from "./decode.js";

const hash = (n: string) => `0x${n.repeat(64)}` as Hex;
const recipient = `0x${"1".repeat(40)}` as const;
const {pin} = pulseFixturePin(recipient, hash("2"), [recipient, recipient], 100);
type Log = ReturnType<typeof normalizeProjectionLog>;
function logs(mode: 0|1): Log[] {
  const common = {address:recipient, blockHash:hash("3"),blockNumber:"0xa",transactionHash:hash("4"),transactionIndex:"0x0",removed:false as const};
  const mint = {handleKey:hash("5"),nonce:hash("6"),recipient,tokenId:BigInt(hash("5")),renderHandle:"Alice",mbti:"INTJ",assessmentDigest:hash("7"),inputDigest:hash("8"),authorizationDigest:hash("9")};
  const economics = {tokenId:mint.tokenId,nonce:mint.nonce,slotId:mode ? PULSE_PAID_SLOT : 0n,mintMode:mode,price:mode ? 10n : 0n,maxPrice:mode ? 12n : 0n,epochIndex:mode ? 1n : 0n};
  const result: Log[] = [
    {...common,logIndex:"0x0",topics:encodeEventTopics({abi:GENERATIVE_MINT_ABI,eventName:"GenerativeSignatureMinted",args:mint}) as Hex[],data:encodeAbiParameters([{type:"uint256"},{type:"string"},{type:"string"},{type:"bytes32"},{type:"bytes32"},{type:"bytes32"}],[mint.tokenId,mint.renderHandle,mint.mbti,mint.assessmentDigest,mint.inputDigest,mint.authorizationDigest])},
    {...common,logIndex:"0x1",topics:encodeEventTopics({abi:PULSE_MINT_ABI,eventName:"MintEconomics",args:economics}) as Hex[],data:encodeAbiParameters([{type:"uint8"},{type:"uint256"},{type:"uint256"},{type:"uint64"}],[mode,economics.price,economics.maxPrice,economics.epochIndex])},
  ];
  if(mode) result.push({...common,logIndex:"0x2",topics:encodeEventTopics({abi:PULSE_MINT_ABI,eventName:"Sale",args:{buyer:recipient,epochIndex:1n}}) as Hex[],data:encodeAbiParameters([{type:"uint256"},{type:"uint64"},{type:"uint64"},{type:"uint256"}],[10n,200n,200n,5n])});
  return result;
}
describe("Pulse projection economic evidence", () => {
  it.each([0,1] as const)("joins the real indexed nonce and keeps mode %s economics", mode => {
    const result=decodePulseEconomics(logs(mode),pin,"200");
    expect([...result.values()]).toEqual([{mintMode:mode,slotId:mode ? PULSE_PAID_SLOT.toString() : "0",price:mode ? "10" : "0",maxPrice:mode ? "12" : "0",epochIndex:mode ? "1" : "0",saleConfigHash:pin.saleConfigHash}]);
  });
  it.each(["missing-economics","missing-sale","trailing-bytes","wrong-nonce","wrong-buyer","two-paid","wrong-time"])("rejects incomplete or crossed receipts: %s", change => {
    let value=logs(1);
    if(change==="missing-economics")value.splice(1,1);
    if(change==="missing-sale")value.pop();
    if(change==="trailing-bytes")value[1]={...value[1],data:`${value[1].data}00`};
    if(change==="wrong-nonce")value[1]={...value[1],topics:[value[1].topics[0],value[1].topics[1],hash("a"),value[1].topics[3]]};
    if(change==="wrong-buyer")value[2]={...value[2],topics:encodeEventTopics({abi:PULSE_MINT_ABI,eventName:"Sale",args:{buyer:`0x${"2".repeat(40)}`,epochIndex:1n}}) as Hex[]};
    if(change==="two-paid")value=[...value,...value];
    expect(()=>decodePulseEconomics(value,pin,change==="wrong-time" ? "201" : "200")).toThrow();
  });
  it("rejects a free economics event at or after the deadline", () => {
    expect(()=>decodePulseEconomics(logs(0),pin,pin.freeDeadline)).toThrow();
  });
});
