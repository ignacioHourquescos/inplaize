// Instalador chico de inplaize: el .exe que se baja de la web.
//
// Abre una ventana con la interfaz de installer/ui (HTML, dentro de WebView2) y,
// al apretar "Comenzar", descarga el instalador completo del release, lo corre
// en silencio y abre la app. Mientras baja, la ventana muestra cómo funciona
// inplaize con la computadora del onboarding.
//
// Se compila con el csc.exe de .NET Framework que trae Windows (C# 5: sin `?.`,
// sin `$""`, sin `nameof`) para no pedir ningún SDK, ni acá ni en el runner de
// GitHub. Lo arma scripts/build-installer.js, que además genera BuildInfo.cs con
// la versión y la dirección de descarga.
//
// Todo va adentro del .exe: las DLL de WebView2 y la carpeta ui son recursos
// embebidos que se sacan a una carpeta temporal al arrancar.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Inplaize.Setup
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            // Antes que nada: las DLL de WebView2 salen de los recursos del .exe.
            // Por eso el resto vive en Run, que no se compila hasta que se la llama.
            AppDomain.CurrentDomain.AssemblyResolve += Embedded.ResolveAssembly;
            return Run(args);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static int Run(string[] args)
        {
            // --dry-run: descarga de verdad pero no instala. Sirve para probar el instalador.
            bool dryRun = Array.IndexOf(args, "--dry-run") >= 0;

            bool first;
            using (Mutex mutex = new Mutex(true, "inplaize-setup", out first))
            {
                if (!first) return 0;

                // GitHub exige TLS 1.2, que .NET Framework no siempre trae prendido.
                ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;

                string workDir = Path.Combine(Path.GetTempPath(), "inplaize-setup");
                Directory.CreateDirectory(workDir);

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new InstallerForm(workDir, dryRun));

                Files.DeleteFolder(Path.Combine(workDir, "ui"));
                Files.DeleteFolder(Path.Combine(workDir, "webview"));
                GC.KeepAlive(mutex);
            }
            return 0;
        }
    }

    /// <summary>Recursos embebidos: las DLL de WebView2 y los archivos de la interfaz.</summary>
    static class Embedded
    {
        static readonly Dictionary<string, Assembly> loaded = new Dictionary<string, Assembly>();

        public static Assembly ResolveAssembly(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name + ".dll";
            lock (loaded)
            {
                Assembly assembly;
                if (loaded.TryGetValue(name, out assembly)) return assembly;
                byte[] data = Read(name);
                if (data == null) return null;
                assembly = Assembly.Load(data);
                loaded[name] = assembly;
                return assembly;
            }
        }

        static byte[] Read(string name)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (stream == null) return null;
                using (MemoryStream copy = new MemoryStream())
                {
                    stream.CopyTo(copy);
                    return copy.ToArray();
                }
            }
        }

        public static void Extract(string name, string target)
        {
            byte[] data = Read(name);
            if (data == null) throw new FileNotFoundException(name);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.WriteAllBytes(target, data);
        }

        /// <summary>Saca a una carpeta todos los recursos cuyo nombre empieza con el prefijo.</summary>
        public static void ExtractFolder(string prefix, string targetDir)
        {
            foreach (string name in Assembly.GetExecutingAssembly().GetManifestResourceNames())
            {
                if (!name.StartsWith(prefix, StringComparison.Ordinal)) continue;
                string relative = name.Substring(prefix.Length).Replace('/', Path.DirectorySeparatorChar);
                Extract(name, Path.Combine(targetDir, relative));
            }
        }
    }

    static class Files
    {
        public static void Delete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception)
            {
                // Queda en la carpeta temporal; no es motivo para frenar nada.
            }
        }

        /// <summary>Borra una carpeta. WebView2 tarda un momento en soltar la suya, así que se insiste un poco.</summary>
        public static void DeleteFolder(string path)
        {
            for (int attempt = 0; attempt < 8; attempt++)
            {
                try
                {
                    if (Directory.Exists(path)) Directory.Delete(path, true);
                    return;
                }
                catch (Exception)
                {
                    Thread.Sleep(250);
                }
            }
        }
    }

    /// <summary>Un paso que falló, con el código que entiende la interfaz.</summary>
    sealed class InstallException : Exception
    {
        public readonly string Code;
        public readonly int Detail;

        public InstallException(string code, int detail) : base(code)
        {
            Code = code;
            Detail = detail;
        }
    }

    /// <summary>
    /// La descarga y la instalación. Corre en un hilo aparte y avisa por los
    /// delegados, que la ventana pasa al hilo de la interfaz.
    /// </summary>
    sealed class Engine
    {
        const int Attempts = 3;
        const int TimeoutMs = 30000;

        public Action<long, long> Progress;
        public Action<string> Phase;
        public Action<string, int> Failed;
        public Action Finished;

        readonly string workDir;
        readonly bool dryRun;
        volatile bool cancelled;
        volatile bool installing;
        volatile HttpWebRequest current;
        int running;

        public Engine(string workDir, bool dryRun)
        {
            this.workDir = workDir;
            this.dryRun = dryRun;
        }

        /// <summary>Mientras corre el instalador no se puede cortar: quedaría a medio instalar.</summary>
        public bool IsInstalling
        {
            get { return installing; }
        }

        public void Start()
        {
            if (Interlocked.Exchange(ref running, 1) == 1) return;
            Task.Factory.StartNew(Run, TaskCreationOptions.LongRunning);
        }

        public void Cancel()
        {
            cancelled = true;
            HttpWebRequest request = current;
            try
            {
                if (request != null) request.Abort();
            }
            catch (Exception)
            {
                // Ya había terminado.
            }
        }

        void Run()
        {
            try
            {
                string setup = Path.Combine(workDir, BuildInfo.SetupFileName);
                Phase("downloading");
                Download(setup);
                Phase("verifying");
                Verify(setup);
                Phase("installing");
                Install(setup);
                Phase("launching");
                WaitForApp();
                Finished();
            }
            catch (InstallException ex)
            {
                if (!cancelled) Failed(ex.Code, ex.Detail);
            }
            catch (Exception)
            {
                if (!cancelled) Failed("install", 0);
            }
            finally
            {
                installing = false;
                Interlocked.Exchange(ref running, 0);
            }
        }

        /// <summary>
        /// Baja el instalador completo. Lo que ya se bajó queda en un .part: si se
        /// corta (o se cierra la ventana), la próxima vez sigue desde ahí.
        /// </summary>
        void Download(string target)
        {
            // Descargas de otra versión que hayan quedado en la carpeta temporal.
            foreach (string old in Directory.GetFiles(workDir, "*.exe*"))
            {
                if (!old.StartsWith(target, StringComparison.OrdinalIgnoreCase)) Files.Delete(old);
            }
            if (File.Exists(target)) return;
            string part = target + ".part";
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    DownloadOnce(part);
                    break;
                }
                catch (InstallException)
                {
                    throw;
                }
                catch (Exception)
                {
                    if (cancelled) throw;
                    if (attempt >= Attempts) throw new InstallException("network", 0);
                    Thread.Sleep(1500 * attempt);
                }
            }
            try
            {
                File.Move(part, target);
            }
            catch (Exception)
            {
                throw new InstallException("disk", 0);
            }
        }

        void DownloadOnce(string part)
        {
            long existing = File.Exists(part) ? new FileInfo(part).Length : 0;

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(BuildInfo.SetupUrl);
            request.UserAgent = "inplaize-setup/" + BuildInfo.Version;
            request.Timeout = TimeoutMs;
            request.ReadWriteTimeout = TimeoutMs;
            request.AllowAutoRedirect = true;
            if (existing > 0) request.AddRange(existing);
            current = request;

            HttpWebResponse response;
            try
            {
                response = (HttpWebResponse)request.GetResponse();
            }
            catch (WebException ex)
            {
                // 416: el .part ya no sirve (por ejemplo, quedó más largo que el archivo). Se empieza de cero.
                HttpWebResponse rejected = ex.Response as HttpWebResponse;
                if (rejected != null && (int)rejected.StatusCode == 416) Files.Delete(part);
                throw;
            }

            using (response)
            {
                bool resumed = response.StatusCode == HttpStatusCode.PartialContent;
                if (!resumed) existing = 0;
                long total = response.ContentLength > 0 ? existing + response.ContentLength : 0;
                long received = existing;

                FileStream output;
                try
                {
                    output = new FileStream(part, resumed ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);
                }
                catch (Exception)
                {
                    throw new InstallException("disk", 0);
                }

                using (output)
                using (Stream input = response.GetResponseStream())
                {
                    byte[] buffer = new byte[1 << 16];
                    int lastReport = Environment.TickCount;
                    Progress(received, total);
                    while (true)
                    {
                        int read = input.Read(buffer, 0, buffer.Length);
                        if (read <= 0) break;
                        if (cancelled) throw new OperationCanceledException();
                        try
                        {
                            output.Write(buffer, 0, read);
                        }
                        catch (IOException)
                        {
                            throw new InstallException("disk", 0);
                        }
                        received += read;
                        if (unchecked(Environment.TickCount - lastReport) >= 100)
                        {
                            lastReport = Environment.TickCount;
                            Progress(received, total);
                        }
                    }
                    Progress(received, total);
                }

                if (total > 0 && received != total) throw new IOException("incomplete download");
            }
        }

        /// <summary>
        /// Si este .exe está firmado, lo que bajó tiene que estar firmado por el
        /// mismo editor: si no, no se ejecuta. En las versiones sin firmar no hay
        /// contra qué comparar y vale lo que llegó por HTTPS desde GitHub.
        /// </summary>
        void Verify(string setup)
        {
            string mine = Authenticode.SignerOf(Application.ExecutablePath);
            if (mine == null) return;
            string theirs = Authenticode.SignerOf(setup);
            if (string.Equals(mine, theirs, StringComparison.Ordinal)) return;
            Files.Delete(setup);
            throw new InstallException("signature", 0);
        }

        /// <summary>
        /// Corre el instalador completo en silencio y abre la app en el onboarding.
        /// No usamos --force-run: ese arranque no lleva ningún argumento y la app
        /// ya instalada se salta el tour. Lo abrimos nosotros con --onboarding.
        /// </summary>
        void Install(string setup)
        {
            if (dryRun)
            {
                Thread.Sleep(2500);
                return;
            }

            installing = true;
            int exitCode;
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(setup, "/S");
                info.UseShellExecute = false;
                info.WorkingDirectory = workDir;
                using (Process process = Process.Start(info))
                {
                    process.WaitForExit();
                    exitCode = process.ExitCode;
                }
            }
            catch (Win32Exception ex)
            {
                exitCode = ex.NativeErrorCode == 0 ? -1 : ex.NativeErrorCode;
            }
            finally
            {
                installing = false;
            }

            // Si falló, la próxima vez se baja de nuevo: no hay forma de saber si el archivo quedó bien.
            Files.Delete(setup);
            if (exitCode != 0) throw new InstallException("install", exitCode);
            LaunchInstalledApp();
        }

        /// <summary>La app instalada. El instalador de NSIS la deja en Programs\inplaize.</summary>
        string FindInstalledExe()
        {
            string name = BuildInfo.AppProcessName + ".exe";
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string perUser = Path.Combine(local, "Programs", BuildInfo.AppProcessName, name);
            if (File.Exists(perUser)) return perUser;
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string perMachine = Path.Combine(programFiles, BuildInfo.AppProcessName, name);
            if (File.Exists(perMachine)) return perMachine;
            return ExeFromUninstallRegistry(name);
        }

        string ExeFromUninstallRegistry(string fileName)
        {
            RegistryKey[] hives = new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine };
            string[] roots = new string[]
            {
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall",
                @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            };
            foreach (RegistryKey hive in hives)
            {
                foreach (string root in roots)
                {
                    try
                    {
                        using (RegistryKey key = hive.OpenSubKey(root))
                        {
                            if (key == null) continue;
                            foreach (string subName in key.GetSubKeyNames())
                            {
                                using (RegistryKey sub = key.OpenSubKey(subName))
                                {
                                    if (sub == null) continue;
                                    object display = sub.GetValue("DisplayName");
                                    if (display == null) continue;
                                    if (display.ToString().IndexOf(BuildInfo.AppProcessName, StringComparison.OrdinalIgnoreCase) < 0) continue;
                                    object icon = sub.GetValue("DisplayIcon");
                                    if (icon == null) continue;
                                    string dir = Path.GetDirectoryName(icon.ToString().Trim().Trim('"'));
                                    if (string.IsNullOrEmpty(dir)) continue;
                                    string exe = Path.Combine(dir, fileName);
                                    if (File.Exists(exe)) return exe;
                                }
                            }
                        }
                    }
                    catch (Exception)
                    {
                        // Sin permiso para leer esa rama: se prueba la siguiente.
                    }
                }
            }
            return null;
        }

        void LaunchInstalledApp()
        {
            string exe = FindInstalledExe();
            if (string.IsNullOrEmpty(exe)) throw new InstallException("install", 0);
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(exe, "--onboarding");
                info.UseShellExecute = true;
                info.WorkingDirectory = Path.GetDirectoryName(exe);
                Process.Start(info);
            }
            catch (Exception)
            {
                throw new InstallException("install", 0);
            }
        }

        /// <summary>La ventana se queda hasta que la app está arriba, así no hay un hueco entre una y otra.</summary>
        void WaitForApp()
        {
            if (dryRun)
            {
                Thread.Sleep(2500);
                return;
            }
            for (int i = 0; i < 40; i++)
            {
                if (AppIsUp()) break;
                Thread.Sleep(250);
            }
            Thread.Sleep(800);
        }

        /// <summary>
        /// El proceso instalado se llama inplaize. Si ya había una copia de desarrollo
        /// abierta, esa se queda con el candado y el proceso nuevo se cierra al toque:
        /// igual le alcanza el pedido de onboarding.
        /// </summary>
        bool AppIsUp()
        {
            if (ProcessRunning(BuildInfo.AppProcessName)) return true;
            return ProcessRunning("electron");
        }

        bool ProcessRunning(string name)
        {
            Process[] found = Process.GetProcessesByName(name);
            bool up = found.Length > 0;
            foreach (Process process in found) process.Dispose();
            return up;
        }
    }

    /// <summary>Firma digital de un .exe (Authenticode).</summary>
    static class Authenticode
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref WINTRUST_DATA data);

        /// <summary>El nombre del editor si el archivo tiene una firma válida; null si no la tiene.</summary>
        public static string SignerOf(string path)
        {
            if (!IsTrusted(path)) return null;
            try
            {
                using (X509Certificate certificate = X509Certificate.CreateFromSignedFile(path))
                {
                    return certificate.Subject;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        static bool IsTrusted(string path)
        {
            WINTRUST_FILE_INFO file = new WINTRUST_FILE_INFO();
            file.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
            file.pcwszFilePath = path;

            IntPtr filePtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
            try
            {
                Marshal.StructureToPtr(file, filePtr, false);
                WINTRUST_DATA data = new WINTRUST_DATA();
                data.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
                data.dwUIChoice = 2;        // WTD_UI_NONE
                data.fdwRevocationChecks = 0; // WTD_REVOKE_NONE
                data.dwUnionChoice = 1;     // WTD_CHOICE_FILE
                data.pFile = filePtr;
                data.dwProvFlags = 0x1000;  // WTD_CACHE_ONLY_URL_RETRIEVAL: sin salir a la red
                Guid action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
                return WinVerifyTrust(IntPtr.Zero, ref action, ref data) == 0;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                Marshal.DestroyStructure(filePtr, typeof(WINTRUST_FILE_INFO));
                Marshal.FreeHGlobal(filePtr);
            }
        }
    }

    sealed class InstallerForm : Form
    {
        // Tamaño para el que está dibujada la interfaz (installer/ui/installer.css).
        const int DesignWidth = 960;
        const int DesignHeight = 560;
        // Dominio de mentira que apunta a la carpeta ui. `.example` no existe, así no se pierde tiempo en el DNS.
        const string UiHost = "setup.inplaize.example";

        readonly string workDir;
        readonly Engine engine;
        float dpiScale = 1f;
        bool finished;

        WebView2 view;
        bool webReady;

        // Respaldo sin WebView2: una ventana simple con lo mínimo.
        Label basicStatus;
        ProgressBar basicBar;
        Button basicButton;

        public InstallerForm(string workDir, bool dryRun)
        {
            this.workDir = workDir;
            engine = new Engine(workDir, dryRun);
            engine.Progress = delegate(long received, long total) { OnUi(delegate { ShowProgress(received, total); }); };
            engine.Phase = delegate(string phase) { OnUi(delegate { ShowPhase(phase); }); };
            engine.Failed = delegate(string code, int detail) { OnUi(delegate { ShowError(code, detail); }); };
            engine.Finished = delegate { OnUi(delegate { finished = true; Close(); }); };

            Text = "Instalar inplaize";
            BackColor = Color.White;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            // Manual: CenterScreen se aplica al crear la ventana, y si el tamaño
            // cambia después la ventana queda corrida. La posición se pone en SetVisibleCore.
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception)
            {
                // Sin ícono propio queda el de Windows.
            }

            screen = Screen.FromPoint(Cursor.Position);
            if (screen == null) screen = Screen.PrimaryScreen;
            dpiScale = SystemDpi();
            ClientSize = Scaled(DesignWidth, DesignHeight, FitFactor());
        }

        Screen screen;
        bool placed;

        /// <summary>
        /// Centra en la pantalla donde está el mouse, ya con el tamaño definitivo.
        /// CreateHandle antes, así el borde de la ventana entra en la cuenta.
        /// </summary>
        protected override void SetVisibleCore(bool value)
        {
            if (value && !placed)
            {
                placed = true;
                if (!IsHandleCreated) CreateHandle();
                Rectangle area = screen.WorkingArea;
                Location = new Point(
                    area.Left + Math.Max(0, (area.Width - Width) / 2),
                    area.Top + Math.Max(0, (area.Height - Height) / 2));
            }
            base.SetVisibleCore(value);
        }

        [DllImport("user32.dll")]
        static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        static extern int GetDeviceCaps(IntPtr hdc, int index);

        /// <summary>DPI del sistema, sin crear la ventana: crearla acá la dejaría mal centrada.</summary>
        static float SystemDpi()
        {
            IntPtr dc = GetDC(IntPtr.Zero);
            try
            {
                int dpi = GetDeviceCaps(dc, 88);
                if (dpi <= 0) return 1f;
                return dpi / 96f;
            }
            finally
            {
                if (dc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, dc);
            }
        }

        /// <summary>En pantallas chicas o con mucho zoom la ventana se achica entera, y la interfaz con ella.</summary>
        float FitFactor()
        {
            Rectangle area = screen.WorkingArea;
            float byWidth = (area.Width - 48f) / (DesignWidth * dpiScale);
            float byHeight = (area.Height - 80f) / (DesignHeight * dpiScale);
            return Math.Max(0.5f, Math.Min(1f, Math.Min(byWidth, byHeight)));
        }

        Size Scaled(int width, int height, float factor)
        {
            return new Size((int)Math.Round(width * dpiScale * factor), (int)Math.Round(height * dpiScale * factor));
        }

        void OnUi(MethodInvoker action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // La ventana se cerró mientras llegaba el aviso.
            }
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            try
            {
                await StartWebUi();
            }
            catch (Exception)
            {
                // Falta WebView2 (pasa en algunos Windows 10 recortados) o no arrancó: se instala igual.
                StartBasicUi();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!finished && engine.IsInstalling)
            {
                e.Cancel = true;
                return;
            }
            engine.Cancel();
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (view != null) view.Dispose();
            base.OnFormClosed(e);
        }

        // ---------------- Interfaz en WebView2 ----------------

        [MethodImpl(MethodImplOptions.NoInlining)]
        async Task StartWebUi()
        {
            string uiDir = Path.Combine(workDir, "ui");
            Files.DeleteFolder(uiDir);
            Files.DeleteFolder(Path.Combine(workDir, "webview"));
            Embedded.ExtractFolder("ui/", uiDir);

            string loader = Path.Combine(workDir, "WebView2Loader.dll");
            try
            {
                Embedded.Extract("loader/" + ProcessArch() + "/WebView2Loader.dll", loader);
            }
            catch (IOException)
            {
                // Quedó de una corrida anterior y sigue en uso: es el mismo archivo.
                if (!File.Exists(loader)) throw;
            }
            CoreWebView2Environment.SetLoaderDllFolderPath(workDir);

            view = new WebView2();
            view.Dock = DockStyle.Fill;
            view.DefaultBackgroundColor = Color.White;
            Controls.Add(view);

            CoreWebView2Environment environment =
                await CoreWebView2Environment.CreateAsync(null, Path.Combine(workDir, "webview"), null);
            await view.EnsureCoreWebView2Async(environment);
            view.ZoomFactor = FitFactor();

            CoreWebView2 core = view.CoreWebView2;
            CoreWebView2Settings settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsBuiltInErrorPageEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;

            // La ventana muestra solo su propia interfaz: no navega a otro lado ni abre ventanas.
            string origin = "https://" + UiHost + "/";
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args)
            {
                if (!args.Uri.StartsWith(origin, StringComparison.OrdinalIgnoreCase)) args.Cancel = true;
            };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
            {
                args.Handled = true;
            };
            core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs args)
            {
                string command;
                try
                {
                    command = args.TryGetWebMessageAsString();
                }
                catch (Exception)
                {
                    return;
                }
                OnCommand(command);
            };

            core.SetVirtualHostNameToFolderMapping(UiHost, uiDir, CoreWebView2HostResourceAccessKind.Deny);
            webReady = true;
            core.Navigate(origin + "index.html");
        }

        static string ProcessArch()
        {
            string arch = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "";
            if (string.Equals(arch, "ARM64", StringComparison.OrdinalIgnoreCase)) return "arm64";
            return Environment.Is64BitProcess ? "x64" : "x86";
        }

        void Post(string json)
        {
            if (!webReady || view == null || view.CoreWebView2 == null) return;
            try
            {
                view.CoreWebView2.PostWebMessageAsJson(json);
            }
            catch (Exception)
            {
                // La vista se está cerrando.
            }
        }

        static string Quote(string text)
        {
            return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        static string Number(long value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        // ---------------- Lo que pide la interfaz ----------------

        void OnCommand(string command)
        {
            if (command == "ready")
            {
                Post("{\"type\":\"init\",\"version\":" + Quote(BuildInfo.Version)
                    + ",\"sizeBytes\":" + Number(BuildInfo.SetupSizeHint) + "}");
            }
            else if (command == "install" || command == "retry")
            {
                engine.Start();
            }
            else if (command == "open-full")
            {
                try
                {
                    Process.Start(BuildInfo.SetupUrl);
                }
                catch (Exception)
                {
                    // Sin navegador por defecto no hay a dónde mandarlo.
                }
            }
        }

        // ---------------- Lo que avisa la instalación ----------------

        void ShowProgress(long received, long total)
        {
            if (basicBar != null)
            {
                if (total > 0)
                {
                    int percent = (int)(received * 100 / total);
                    basicBar.Style = ProgressBarStyle.Continuous;
                    basicBar.Value = Math.Max(0, Math.Min(100, percent));
                    basicStatus.Text = "Descargando… " + percent + " %";
                }
                return;
            }
            Post("{\"type\":\"progress\",\"received\":" + Number(received) + ",\"total\":" + Number(total) + "}");
        }

        void ShowPhase(string phase)
        {
            if (basicBar != null)
            {
                basicButton.Visible = false;
                basicBar.Visible = true;
                if (phase != "downloading") basicBar.Style = ProgressBarStyle.Marquee;
                if (phase == "downloading") basicStatus.Text = "Descargando…";
                else if (phase == "verifying") basicStatus.Text = "Verificando la descarga…";
                else if (phase == "installing") basicStatus.Text = "Instalando…";
                else if (phase == "launching") basicStatus.Text = "Listo. Abriendo inplaize…";
                return;
            }
            Post("{\"type\":\"phase\",\"phase\":" + Quote(phase) + "}");
        }

        void ShowError(string code, int detail)
        {
            if (basicBar != null)
            {
                basicBar.Visible = false;
                basicButton.Text = "Reintentar";
                basicButton.Visible = true;
                if (code == "disk") basicStatus.Text = "No se pudo guardar la descarga. Fijate que haya lugar en el disco.";
                else if (code == "signature") basicStatus.Text = "La descarga no pasó la verificación de firma, así que no se instaló.";
                else if (code == "install") basicStatus.Text = "La instalación no terminó. Probá de nuevo.";
                else basicStatus.Text = "No se pudo descargar inplaize. Revisá la conexión y probá de nuevo.";
                return;
            }
            Post("{\"type\":\"error\",\"code\":" + Quote(code) + ",\"detail\":" + Number(detail) + "}");
        }

        // ---------------- Respaldo sin WebView2 ----------------

        void StartBasicUi()
        {
            webReady = false;
            if (view != null)
            {
                Controls.Remove(view);
                view.Dispose();
                view = null;
            }

            ClientSize = Scaled(460, 190, 1f);
            CenterToScreen();
            Font = new Font("Segoe UI", 9.5f);

            Label title = new Label();
            title.Text = "inplaize " + BuildInfo.Version;
            title.Font = new Font("Segoe UI", 15f);
            title.SetBounds(S(24), S(22), S(412), S(34));

            basicStatus = new Label();
            basicStatus.Text = "Se descarga la app y se instala para tu usuario. No pide permisos de administrador.";
            basicStatus.SetBounds(S(24), S(64), S(412), S(40));

            basicBar = new ProgressBar();
            basicBar.Visible = false;
            basicBar.SetBounds(S(24), S(124), S(412), S(14));

            basicButton = new Button();
            basicButton.Text = "Comenzar";
            basicButton.SetBounds(S(316), S(132), S(120), S(34));
            basicButton.Click += delegate { engine.Start(); };

            Controls.Add(title);
            Controls.Add(basicStatus);
            Controls.Add(basicBar);
            Controls.Add(basicButton);
            AcceptButton = basicButton;
        }

        int S(int value)
        {
            return (int)Math.Round(value * dpiScale);
        }
    }
}
