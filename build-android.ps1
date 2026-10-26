$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# Все настройки действуют только в этом процессе, инструменты и кэши остаются в reading.
if (-not $env:JAVA_HOME) {
    $jdk_folder = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.tools') -Directory -Filter 'jdk-*' | Select-Object -First 1
    if (-not $jdk_folder) { throw 'Не найден JDK 21. Укажи JAVA_HOME в текущем терминале.' }
    $env:JAVA_HOME = $jdk_folder.FullName
}
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $PSScriptRoot '.tools/android-sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $env:ANDROID_HOME 'platforms/android-36/android.jar'))) { throw 'Не найден Android SDK 36. Укажи ANDROID_HOME в текущем терминале.' }
$env:ANDROID_USER_HOME = Join-Path $PSScriptRoot '.tools/android-user'
$env:GRADLE_USER_HOME = Join-Path $PSScriptRoot '.tools/gradle'
$env:JAVA_TOOL_OPTIONS = '-Duser.home=' + (Join-Path $PSScriptRoot '.tools/java-home')

node build-web.js
if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить веб-ресурсы' }
node node_modules/@capacitor/cli/bin/capacitor sync android
if ($LASTEXITCODE -ne 0) { throw 'Не удалось обновить Android-проект' }

$signing_folder = Join-Path $PSScriptRoot '.tools/signing'
New-Item -ItemType Directory -Force -Path $signing_folder | Out-Null
$key_file = Join-Path $signing_folder 'debug.keystore'
if (-not (Test-Path -LiteralPath $key_file)) {
    & (Join-Path $env:JAVA_HOME 'bin/keytool.exe') -genkeypair -keystore $key_file -storepass android -keypass android -alias androiddebugkey -dname 'CN=Reading Debug,O=Reading,C=GE' -keyalg RSA -keysize 2048 -validity 10000
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать ключ тестовой сборки' }
}
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'android')
try {
    & ./gradlew.bat --no-daemon --console=plain :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'Сборка APK завершилась ошибкой' }
} finally { Pop-Location }
$artifacts = Join-Path $PSScriptRoot 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
Copy-Item -LiteralPath 'android/app/build/outputs/apk/debug/app-debug.apk' -Destination (Join-Path $artifacts 'reading-debug.apk')
Write-Output ('APK готов: ' + (Join-Path $artifacts 'reading-debug.apk'))
