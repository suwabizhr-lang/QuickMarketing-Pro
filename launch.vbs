' Kaitori Marketing System launcher (ASCII only to avoid cp932 parse errors)
' Starts the server hidden (no console window) and opens the browser.
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = projDir

nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

' Start server hidden (0 = hidden window, False = do not wait).
' A second launch will hit EADDRINUSE and exit quietly (handled in server).
sh.Run """" & nodeExe & """ --disable-warning=ExperimentalWarning src\server\index.js", 0, False

' Wait for the server, then open the browser.
WScript.Sleep 3000
sh.Run "http://localhost:5300", 1, False
