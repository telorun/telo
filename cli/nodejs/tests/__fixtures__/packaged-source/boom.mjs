// Throws the moment anything imports it: a command that reads a packaged
// executable as a manifest source must never get this far.
throw new Error("the packaged controller was imported");
