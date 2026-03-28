// Browser stub for Node.js fs/promises — NodeAdapter is never called in the browser.
export const stat = async (_path: string) => null
export const readFile = async (_path: string, _encoding?: string): Promise<string> => { throw new Error('fs not available in browser') }
export const writeFile = async () => { throw new Error('fs not available in browser') }
export const mkdir = async () => { throw new Error('fs not available in browser') }
export default {}
