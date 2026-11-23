; Inno Setup script for MyDownloadManager (Windows 10/11 x64).
; Build:  iscc installer\MyDownloadManager.iss   (after build\build.ps1 has produced artifacts\publish\app)
; Output: artifacts\installer\MyDownloadManager_Setup.exe

#define AppName "MyDownloadManager"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppPublisher "MyDownloadManager contributors"
#define AppExe "MyDownloadManager.exe"
#define Root ".."

[Setup]
AppId={{6B3E7C1A-4F2D-4C8B-9E51-2D7A0F8C3B64}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
; Per-user install by default (no admin rights needed); users may choose "all users" in the dialog.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#Root}\artifacts\installer
OutputBaseFilename=MyDownloadManager_Setup
SetupIconFile={#Root}\assets\MyDownloadManager.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
LicenseFile={#Root}\LICENSE.txt
InfoAfterFile={#Root}\installer\AFTER_INSTALL.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "autostart"; Description: "Start {#AppName} when I sign in to Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
; Application + native messaging host (self-contained .NET runtime, shared by both executables).
Source: "{#Root}\artifacts\publish\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Browser extensions (unpacked folders for "Load unpacked", plus zip packages).
Source: "{#Root}\extensions\dist\chromium\*"; DestDir: "{app}\extensions\chromium"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Root}\extensions\dist\firefox\*"; DestDir: "{app}\extensions\firefox"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Root}\extensions\dist\*.zip"; DestDir: "{app}\extensions"; Flags: ignoreversion
; Optional LGPL FFmpeg build (see docs\FFMPEG.md); skipped when not downloaded by the build script.
Source: "{#Root}\artifacts\ffmpeg\*"; DestDir: "{app}\ffmpeg"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
; Documentation and licenses.
Source: "{#Root}\README.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "{#Root}\docs\*.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "{#Root}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Browser extensions folder"; Filename: "{app}\extensions"
Name: "{group}\Troubleshooting"; Filename: "{app}\docs\TROUBLESHOOTING.md"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; \
  ValueData: """{app}\{#AppExe}"" --background"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Register the native messaging host for Chrome, Edge, Chromium, Brave and Firefox (HKCU, no admin needed).
Filename: "{app}\{#AppExe}"; Parameters: "--register-browsers"; StatusMsg: "Registering browser integration..."; Flags: runhidden waituntilterminated
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\docs\BROWSER_EXTENSIONS.md"; Description: "Show browser extension setup instructions"; Flags: postinstall shellexec skipifsilent unchecked

[UninstallRun]
Filename: "{app}\{#AppExe}"; Parameters: "--unregister-browsers"; RunOnceId: "UnregisterBrowsers"; Flags: runhidden waituntilterminated

[Code]
// Downloads and settings are user data and are kept on uninstall; tell the user where they are.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    MsgBox('Your downloaded files and download history were not removed.' + #13#10 +
           'History and settings: ' + ExpandConstant('{localappdata}\MyDownloadManager'), mbInformation, MB_OK);
end;
