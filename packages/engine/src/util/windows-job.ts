/** Windows job ownership: descendants die when the launcher exits, even after their parent exits. */
export function windowsJobCommand(file: string, args: string[], verbatim = false): { file: string; args: string[] } {
  const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  const commandLine = [quote(file), ...(verbatim ? args : args.map(quote))].join(' ')
  const payload = Buffer.from(JSON.stringify({ file, commandLine }), 'utf8').toString('base64')
  const createdAt = new Date().toISOString()
  // Create suspended, assign before resuming: no child can escape the ownership job in the gap.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$owner = [Diagnostics.Process]::GetProcessById(${process.pid})
if ($owner.StartTime.ToUniversalTime() -gt [DateTime]::Parse('${createdAt}').ToUniversalTime()) { throw 'Process owner changed before job startup.' }
$ownerHandle = $owner.Handle
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OwnedProcess {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public IntPtr reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASICLIMIT { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASICLIMIT basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref LIMIT v, int size);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string f, System.Text.StringBuilder cmd, IntPtr a, IntPtr b, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO s, out PROCESSINFO p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr p, uint timeout);
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  public static int Run(string file, string command, IntPtr owner) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception();
    PROCESSINFO p=new PROCESSINFO();
    try {
      LIMIT limit=new LIMIT(); limit.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(limit))) throw new Win32Exception();
      STARTUPINFO s=new STARTUPINFO(); s.cb=Marshal.SizeOf(s); s.flags=0x100; s.input=GetStdHandle(-10); s.output=GetStdHandle(-11); s.error=GetStdHandle(-12);
      if(!CreateProcess(file,new System.Text.StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref s,out p)) throw new Win32Exception();
      if(!AssignProcessToJobObject(job,p.process)) { TerminateProcess(p.process,1); throw new Win32Exception(); }
      if(ResumeThread(p.thread)==0xffffffff) { TerminateProcess(p.process,1); throw new Win32Exception(); }
      uint ended=WaitForMultipleObjects(2,new IntPtr[]{p.process,owner},false,0xffffffff);
      if(ended!=0) return 125;
      uint code; GetExitCodeProcess(p.process,out code); return unchecked((int)code);
    } finally { CloseHandle(job); if(p.thread!=IntPtr.Zero) CloseHandle(p.thread); if(p.process!=IntPtr.Zero) CloseHandle(p.process); }
  }
}
'@
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
exit ([OwnedProcess]::Run($data.file, $data.commandLine, $ownerHandle))
`
  return { file: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
}
