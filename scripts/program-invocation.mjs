/**
 * 构造一次不经 shell 的程序调用。
 * Windows 上的 .bat/.cmd 不能直接交给 execFile，必须经 cmd.exe。
 */
export function programInvocation(file, args, platform = process.platform) {
  const argv = Array.isArray(args) ? args.map((item) => String(item)) : [];
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(file)) {
    const quote = (part) => (/[\s"&|<>^]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part);
    const command = [file, ...argv].map(quote).join(' ');
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`] };
  }
  return { file, args: argv };
}
