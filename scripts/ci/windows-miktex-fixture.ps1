$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable GitHub runner required' }
$directory = Join-Path $env:RUNNER_TEMP 'TeXpresso bridge fixture'
$null = New-Item -ItemType Directory -Force $directory
$program = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
class Lookup {
  static void Main(string[] arguments) {
    if (Array.IndexOf(arguments,"--worker") >= 0) { Thread.Sleep(60000); return; }
    if (Array.IndexOf(arguments,"--version") >= 0) { Console.WriteLine("MiKTeX cancellation fixture"); return; }
    string executable = Assembly.GetExecutingAssembly().Location;
    string folder = Path.GetDirectoryName(executable);
    File.WriteAllText(Path.Combine(folder,"lookup.pid"),Process.GetCurrentProcess().Id.ToString());
    var info = new ProcessStartInfo(executable,"--worker"); info.UseShellExecute=false; info.CreateNoWindow=true;
    var child = Process.Start(info);
    File.WriteAllText(Path.Combine(folder,"worker.pid"),child.Id.ToString());
    Thread.Sleep(60000);
  }
}
'@
Add-Type -TypeDefinition $program -OutputAssembly (Join-Path $directory 'findtexmf.exe') -OutputType ConsoleApplication
