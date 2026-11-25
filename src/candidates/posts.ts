import { CandidateError, checkedHandle, isShape } from "./curve.js";

export const CANDIDATE_FORMAT = 2;
export type CitedPost = { url: string; author: string };

// These are reported sources, never an attestation of retrieval or authorship.
// Production Grok must actually retrieve accessible public posts by this handle.
export function readPosts(value: unknown, handle: string): CitedPost[] {
  if (!Array.isArray(value) || !value.length) throw new CandidateError("no_qualifying_public_post");
  if (value.length > 8) throw new CandidateError("too_many_cited_posts");
  const seen = new Set<string>();
  return value.map(post => {
    if (!isShape(post, ["url", "author"]) || typeof post.url !== "string" || typeof post.author !== "string") {
      throw new CandidateError("invalid_cited_post");
    }
    const match = /^https:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]{0,24})(?![\s\S])/.exec(post.url);
    if (!match || post.author !== checkedHandle(post.author) || post.author.toLowerCase() !== handle.toLowerCase()
        || match[1].toLowerCase() !== handle.toLowerCase() || seen.has(match[2])) {
      throw new CandidateError("invalid_cited_post");
    }
    seen.add(match[2]);
    return { url: post.url, author: post.author };
  });
}
