/**
 * A fixture extension that does exactly one interesting thing: write a file on
 * mount and render what happened.
 *
 * It exists so the runtime-permission test drives a *real* guest through the
 * real bundler and the real guest runtime, rather than a hand-written stub
 * against protocol internals. The thing under test is whether the guest's own
 * promise wakes up after the user approves, and a stub that resolves its own
 * promises would not be able to show that.
 */

import { Detail, useEffect, useState, workspace } from "@writer/extension-api";

function Write() {
  const [status, setStatus] = useState("writing");

  useEffect(() => {
    let live = true;
    workspace
      .write("notes/a.md", "hello")
      .then(() => {
        if (live) setStatus("wrote");
      })
      .catch((err: unknown) => {
        if (live) setStatus(`refused: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      live = false;
    };
  }, []);

  return <Detail markdown={status} />;
}

export default {
  commands: {
    write: Write,
  },
};
