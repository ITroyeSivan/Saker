import { refreshDesktopShortcut } from './lib/desktop-shortcut.mjs'
const args = process.argv.slice(2)
const values = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--desktop-dir', '--user-data-dir', '--workspace'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/update-desktop-shortcut.mjs --desktop-dir <official Desktop directory> [--user-data-dir <existing daily profile>] [--workspace <workspace>]')
  values[args[i]] = args[i + 1]
}
if (!values['--desktop-dir']) throw new Error('--desktop-dir is required')
console.log(JSON.stringify(refreshDesktopShortcut({ desktopDirectory: values['--desktop-dir'], userDataDirectory: values['--user-data-dir'], workspace: values['--workspace'] }), null, 2))
