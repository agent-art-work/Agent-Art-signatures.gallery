/** Self-contained for embedding in both browser clients. Only a handle draft,
 * never wallet proof, price consent or submission state, is persisted here. */
export function mintHandleDraft(
  input: { value: string; defaultValue?: string } | null,
  suppliedStorage?: Pick<Storage, "getItem" | "setItem">,
): () => void {
  if (!input) return () => {};
  const key = "sg-open:mint-handle-draft:v1";
  const source = input.defaultValue ?? input.value;
  let storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  try {
    storage = suppliedStorage ?? sessionStorage;
    const raw = storage.getItem(key);
    const saved = raw && raw.length <= 256 ? JSON.parse(raw) : null;
    if (saved?.version === 1 && typeof saved.value === "string" && saved.value.length <= 16
      && typeof saved.source === "string" && saved.source.length <= 16
      && (!source || saved.source === source)) input.value = saved.value;
  } catch { /* Storage can be blocked; minting must remain usable. */ }
  // Object-method syntax stays self-contained when tsx preserves function
  // names; a named arrow here would inject an external __name helper.
  const draft = {
    save() {
      try {
        if (input.value.length <= 16 && source.length <= 16) {
          storage?.setItem(key, JSON.stringify({ version: 1, source, value: input.value }));
        }
      } catch { /* A full/disabled store must not interrupt typing or submission. */ }
    },
  };
  // A different URL-prefilled handle supersedes the old draft. Edits to that
  // prefilled handle still survive a refresh of the same URL, including empty.
  draft.save();
  return draft.save;
}
