param([int]$ProcessId,[int]$X=1700,[int]$Y=1000,[int]$Dx=120,[int]$Dy=60,[double]$ClientX,[double]$ClientY,[double]$Dpr=1,[switch]$ClientCoordinates,[ValidateSet('Before','After','None')][string]$ModifierTiming='Before',[switch]$CursorOnly)
$ErrorActionPreference='Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class BcmMouseProbe {
public delegate bool Callback(IntPtr h,IntPtr l);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr h,Callback c,IntPtr l);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder b,int n);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);
public struct Rect{public int left,top,right,bottom;}
public static Rect Caption(IntPtr h){Rect found=new Rect();EnumChildWindows(h,(w,l)=>{var b=new StringBuilder(256);GetClassName(w,b,256);if(b.ToString()=="InputNonClientPointerSource"){GetWindowRect(w,out found);return false;}return true;},IntPtr.Zero);if(found.bottom<=found.top)throw new Exception("Caption geometry unavailable");return found;}

[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
}
'@
$taskProcess=Get-Process -Id $ProcessId
if($taskProcess.MainWindowTitle -notlike '*BCM.nendo*'){throw 'Expected the BCM window'}
$taskShell=New-Object -ComObject WScript.Shell
[void]$taskShell.AppActivate($ProcessId)
Start-Sleep -Milliseconds 200
[uint32]$taskForegroundProcess=0
[void][BcmMouseProbe]::GetWindowThreadProcessId([BcmMouseProbe]::GetForegroundWindow(),[ref]$taskForegroundProcess)
if($taskForegroundProcess -ne $ProcessId){throw 'BCM did not become the foreground window'}
if($ClientCoordinates){$taskCaption=[BcmMouseProbe]::Caption($taskProcess.MainWindowHandle);$X=$taskCaption.left+[int]($ClientX*$Dpr);$Y=$taskCaption.bottom+[int]($ClientY*$Dpr)}
[void][BcmMouseProbe]::SetCursorPos($X,$Y)
try {
  if($ModifierTiming -eq 'Before'){[BcmMouseProbe]::keybd_event(0x11,0,0,[UIntPtr]::Zero)}
  Start-Sleep -Milliseconds 150
  [BcmMouseProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  if($ModifierTiming -eq 'After'){Start-Sleep -Milliseconds 100;[BcmMouseProbe]::keybd_event(0x11,0,0,[UIntPtr]::Zero)}
  for($taskStep=1;$taskStep -le 12;$taskStep++) {
    if($CursorOnly){[void][BcmMouseProbe]::SetCursorPos(($X+[int]($taskStep*$Dx/12)),($Y+[int]($taskStep*$Dy/12)))}else{[BcmMouseProbe]::mouse_event(0x8001,[uint32](($X+$taskStep*$Dx/12)*65535/([BcmMouseProbe]::GetSystemMetrics(0)-1)),[uint32](($Y+$taskStep*$Dy/12)*65535/([BcmMouseProbe]::GetSystemMetrics(1)-1)),0,[UIntPtr]::Zero)}
    Start-Sleep -Milliseconds 30
  }
} finally {
  [BcmMouseProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  [BcmMouseProbe]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
}
