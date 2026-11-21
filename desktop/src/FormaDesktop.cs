using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace FormaDesktop
{
    internal static class NativeMethods
    {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        public const uint WM_CLOSE = 0x0010;

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        public const int SW_RESTORE = 9;
        public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        public static void EnableDarkTitleBar(IntPtr handle)
        {
            try
            {
                int useDark = 1;
                DwmSetWindowAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref useDark, sizeof(int));
            }
            catch
            {
            }
        }

        public static IntPtr CreateKillOnCloseJob()
        {
            IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
            if (hJob == IntPtr.Zero) return IntPtr.Zero;

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ptr, (uint)length);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
            return hJob;
        }

        public static IntPtr FindStudioAppWindow(int excludePid)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if ((int)pid == excludePid) return true;

                int len = GetWindowTextLength(hWnd);
                if (len <= 0 || len > 256) return true;

                StringBuilder sb = new StringBuilder(len + 2);
                GetWindowText(hWnd, sb, sb.Capacity);
                string title = sb.ToString();

                // Match the Studio app window ("Forma 空间工作台") while excluding the C# console window
                if (title.IndexOf("Forma 空间工作台", StringComparison.OrdinalIgnoreCase) >= 0 &&
                    title.IndexOf("Windows 客户端", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    found = hWnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        public static void FocusWindow(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return;
            try
            {
                if (IsIconic(hWnd))
                {
                    ShowWindow(hWnd, SW_RESTORE);
                }
                SetForegroundWindow(hWnd);
            }
            catch
            {
            }
        }
    }

    internal static class Theme
    {
        public static readonly Color BgCanvas = Color.FromArgb(20, 20, 19);       // #141413
        public static readonly Color BgIsland = Color.FromArgb(30, 30, 28);       // #1E1E1C
        public static readonly Color BgCard = Color.FromArgb(37, 37, 34);         // #252522
        public static readonly Color BgInput = Color.FromArgb(44, 44, 40);        // #2C2C28
        public static readonly Color BorderSubtle = Color.FromArgb(58, 58, 52);   // #3A3A34
        public static readonly Color AccentLime = Color.FromArgb(212, 255, 51);   // #D4FF33
        public static readonly Color TextPrimary = Color.FromArgb(242, 239, 233); // #F2EFE9
        public static readonly Color TextMuted = Color.FromArgb(158, 155, 147);   // #9E9B93
        public static readonly Color StatusOk = Color.FromArgb(74, 222, 128);     // #4ADE80
        public static readonly Color StatusWarn = Color.FromArgb(251, 191, 36);   // #FBBF24
        public static readonly Color StatusErr = Color.FromArgb(248, 113, 113);   // #F87171
    }

    internal sealed class StartupSplashForm : Form
    {
        private readonly Label _statusLabel;

        public StartupSplashForm(Icon appIcon)
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(380, 92);
            BackColor = Theme.BgIsland;
            ForeColor = Theme.TextPrimary;
            ShowInTaskbar = false;
            TopMost = true;
            if (appIcon != null) Icon = appIcon;

            Panel border = new Panel();
            border.Location = new Point(1, 1);
            border.Size = new Size(378, 90);
            border.BackColor = Theme.BgCanvas;
            Controls.Add(border);

            Label badge = new Label();
            badge.Text = "FORMA";
            badge.BackColor = Theme.AccentLime;
            badge.ForeColor = Theme.BgCanvas;
            badge.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
            badge.TextAlign = ContentAlignment.MiddleCenter;
            badge.Location = new Point(18, 26);
            badge.Size = new Size(68, 36);
            border.Controls.Add(badge);

            Label title = new Label();
            title.Text = "Forma 空间工作台";
            title.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
            title.ForeColor = Theme.TextPrimary;
            title.Location = new Point(100, 22);
            title.Size = new Size(260, 24);
            border.Controls.Add(title);

            _statusLabel = new Label();
            _statusLabel.Text = "正在启动本地创作服务，请稍候...";
            _statusLabel.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Regular);
            _statusLabel.ForeColor = Theme.TextMuted;
            _statusLabel.Location = new Point(100, 48);
            _statusLabel.Size = new Size(264, 20);
            border.Controls.Add(_statusLabel);
        }

        public void UpdateProgress(string text)
        {
            if (IsDisposed) return;
            _statusLabel.Text = text;
        }
    }

    internal sealed class DotEnvManager
    {
        public static readonly string[] KnownKeys = new string[]
        {
            "CODING_AGENT_BASE_URL",
            "CODING_AGENT_MODEL",
            "CODING_AGENT_API_KEY",
            "SPEECH_BASE_URL",
            "SPEECH_MODEL",
            "DASHSCOPE_API_KEY",
            "LUX3D_BASE",
            "LUX3D_API_KEY"
        };

        public static Dictionary<string, string> ReadEnv(string filePath)
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.Ordinal);
            if (!File.Exists(filePath)) return map;

            string raw = File.ReadAllText(filePath, Encoding.UTF8);
            if (raw.Length > 0 && raw[0] == '\uFEFF')
            {
                raw = raw.Substring(1);
            }

            string[] lines = raw.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string line in lines)
            {
                string trimmed = line.Trim();
                if (trimmed.Length == 0 || trimmed.StartsWith("#")) continue;
                int eq = trimmed.IndexOf('=');
                if (eq <= 0) continue;
                string key = trimmed.Substring(0, eq).Trim().TrimStart('\uFEFF');
                string val = trimmed.Substring(eq + 1).Trim();
                if ((val.StartsWith("\"") && val.EndsWith("\"")) || (val.StartsWith("'") && val.EndsWith("'")))
                {
                    if (val.Length >= 2) val = val.Substring(1, val.Length - 2);
                }
                map[key] = val;
            }
            return map;
        }

        public static void WriteEnv(string filePath, Dictionary<string, string> updates)
        {
            string dir = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            List<string> outputLines = new List<string>();
            HashSet<string> written = new HashSet<string>(StringComparer.Ordinal);

            if (File.Exists(filePath))
            {
                string raw = File.ReadAllText(filePath, Encoding.UTF8);
                if (raw.Length > 0 && raw[0] == '\uFEFF') raw = raw.Substring(1);
                string[] existingLines = raw.Replace("\r\n", "\n").Split('\n');

                foreach (string line in existingLines)
                {
                    string trimmed = line.Trim();
                    if (trimmed.Length == 0 || trimmed.StartsWith("#"))
                    {
                        outputLines.Add(line);
                        continue;
                    }
                    int eq = trimmed.IndexOf('=');
                    if (eq <= 0)
                    {
                        outputLines.Add(line);
                        continue;
                    }
                    string key = trimmed.Substring(0, eq).Trim().TrimStart('\uFEFF');
                    if (updates.ContainsKey(key))
                    {
                        string newVal = (updates[key] ?? "").Trim();
                        if (newVal.Length > 0)
                        {
                            outputLines.Add(key + "=" + newVal);
                        }
                        written.Add(key);
                    }
                    else
                    {
                        outputLines.Add(line);
                    }
                }
            }

            foreach (string key in KnownKeys)
            {
                if (!written.Contains(key) && updates.ContainsKey(key))
                {
                    string val = (updates[key] ?? "").Trim();
                    if (val.Length > 0)
                    {
                        outputLines.Add(key + "=" + val);
                    }
                }
            }

            while (outputLines.Count > 0 && string.IsNullOrWhiteSpace(outputLines[outputLines.Count - 1]))
            {
                outputLines.RemoveAt(outputLines.Count - 1);
            }

            string finalText = string.Join("\r\n", outputLines.ToArray());
            if (finalText.Length > 0) finalText += "\r\n";

            File.WriteAllText(filePath, finalText, new UTF8Encoding(false));
        }
    }

    internal sealed class EnvConfigDialog : Form
    {
        private readonly string _envPath;
        private readonly Dictionary<string, TextBox> _inputs = new Dictionary<string, TextBox>(StringComparer.Ordinal);
        private CheckBox _showSecretsCheck;
        public bool ShouldRestartService { get; private set; }

        public EnvConfigDialog(string envPath, Icon appIcon)
        {
            _envPath = envPath;
            ShouldRestartService = false;

            Text = "Forma 模型与 API 密钥配置 (apps/server/.env)";
            Size = new Size(700, 610);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Theme.BgCanvas;
            ForeColor = Theme.TextPrimary;
            Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            if (appIcon != null) Icon = appIcon;

            BuildUi();
            LoadCurrentValues();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            NativeMethods.EnableDarkTitleBar(Handle);
        }

        private void BuildUi()
        {
            Label header = new Label();
            header.Text = "配置真实 AI 模型连接（UTF-8 无 BOM 安全写入 apps/server/.env）";
            header.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
            header.ForeColor = Theme.AccentLime;
            header.Location = new Point(22, 16);
            header.Size = new Size(640, 26);
            Controls.Add(header);

            Label sub = new Label();
            sub.Text = "提示：也可直接在工作台右上角点击「接入模型」在线热更新配置并测试连通性。";
            sub.ForeColor = Theme.TextMuted;
            sub.Location = new Point(22, 44);
            sub.Size = new Size(640, 22);
            Controls.Add(sub);

            Label presetLbl = new Label();
            presetLbl.Text = "一键选择主流厂商预设";
            presetLbl.ForeColor = Theme.AccentLime;
            presetLbl.Location = new Point(22, 78);
            presetLbl.Size = new Size(270, 24);
            Controls.Add(presetLbl);

            string[][] presets = new string[][]
            {
                new string[] { "阿里云百炼 (DashScope 通用)", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-coder-plus" },
                new string[] { "阿里云百炼 (Coding Plan 专享)", "https://coding.dashscope.aliyuncs.com/v1", "qwen3-coder-plus" },
                new string[] { "DeepSeek (深度求索官方)", "https://api.deepseek.com/v1", "deepseek-chat" },
                new string[] { "硅基流动 (SiliconFlow)", "https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-Coder-32B-Instruct" },
                new string[] { "火山方舟 (字节豆包 Volcengine Ark)", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-6-250615" },
                new string[] { "智谱清言 (BigModel GLM)", "https://open.bigmodel.cn/api/paas/v4", "glm-4-plus" },
                new string[] { "月之暗面 (Kimi / Moonshot)", "https://api.moonshot.cn/v1", "kimi-k2-0711-preview" },
                new string[] { "OpenAI / 第三方兼容中转站", "https://api.openai.com/v1", "gpt-4.1" },
                new string[] { "Ollama / LM Studio (本机私有模型)", "http://127.0.0.1:11434/v1", "qwen2.5-coder:14b" }
            };

            ComboBox presetCombo = new ComboBox();
            presetCombo.DropDownStyle = ComboBoxStyle.DropDownList;
            presetCombo.BackColor = Theme.BgInput;
            presetCombo.ForeColor = Theme.TextPrimary;
            presetCombo.FlatStyle = FlatStyle.Flat;
            presetCombo.Location = new Point(298, 75);
            presetCombo.Size = new Size(360, 28);
            foreach (string[] p in presets)
            {
                presetCombo.Items.Add(p[0] + " — " + p[2]);
            }
            presetCombo.SelectedIndexChanged += delegate
            {
                int idx = presetCombo.SelectedIndex;
                if (idx >= 0 && idx < presets.Length)
                {
                    if (_inputs.ContainsKey("CODING_AGENT_BASE_URL")) _inputs["CODING_AGENT_BASE_URL"].Text = presets[idx][1];
                    if (_inputs.ContainsKey("CODING_AGENT_MODEL")) _inputs["CODING_AGENT_MODEL"].Text = presets[idx][2];
                }
            };
            Controls.Add(presetCombo);

            string[][] fields = new string[][]
            {
                new string[] { "CODING_AGENT_BASE_URL", "代码生成 Base URL", "https://dashscope.aliyuncs.com/compatible-mode/v1", "0" },
                new string[] { "CODING_AGENT_MODEL", "代码生成模型名称", "qwen3-coder-plus", "0" },
                new string[] { "CODING_AGENT_API_KEY", "代码生成 API Key", "sk-...", "1" },
                new string[] { "SPEECH_BASE_URL", "语音识别 Base URL", "https://dashscope.aliyuncs.com/compatible-mode/v1", "0" },
                new string[] { "SPEECH_MODEL", "语音识别模型名称", "qwen3-asr-flash", "0" },
                new string[] { "DASHSCOPE_API_KEY", "语音识别 API Key", "sk-...", "1" },
                new string[] { "LUX3D_BASE", "Lux3D 3D 服务地址", "https://api.aholo.cn", "0" },
                new string[] { "LUX3D_API_KEY", "Lux3D API Key", "lux-...", "1" }
            };

            int y = 118;
            foreach (string[] field in fields)
            {
                string key = field[0];
                string labelText = field[1];
                bool isSecret = field[3] == "1";

                Label lbl = new Label();
                lbl.Text = labelText + " (" + key + ")";
                lbl.ForeColor = Theme.TextPrimary;
                lbl.Location = new Point(22, y + 3);
                lbl.Size = new Size(270, 24);
                Controls.Add(lbl);

                TextBox tb = new TextBox();
                tb.Location = new Point(298, y);
                tb.Size = new Size(360, 26);
                tb.BackColor = Theme.BgInput;
                tb.ForeColor = Theme.TextPrimary;
                tb.BorderStyle = BorderStyle.FixedSingle;
                tb.Font = new Font("Consolas", 9.5f, FontStyle.Regular);
                if (isSecret)
                {
                    tb.UseSystemPasswordChar = true;
                    tb.Tag = "secret";
                }
                Controls.Add(tb);
                _inputs[key] = tb;

                y += 44;
            }

            _showSecretsCheck = new CheckBox();
            _showSecretsCheck.Text = "显示明文 API Key";
            _showSecretsCheck.ForeColor = Theme.TextMuted;
            _showSecretsCheck.Location = new Point(298, y + 4);
            _showSecretsCheck.Size = new Size(200, 24);
            _showSecretsCheck.CheckedChanged += delegate
            {
                bool show = _showSecretsCheck.Checked;
                foreach (TextBox tb in _inputs.Values)
                {
                    if ((tb.Tag as string) == "secret")
                    {
                        tb.UseSystemPasswordChar = !show;
                    }
                }
            };
            Controls.Add(_showSecretsCheck);

            Button btnSaveRestart = CreateButton("保存并重启服务", Theme.AccentLime, Theme.BgCanvas, true);
            btnSaveRestart.Location = new Point(298, 514);
            btnSaveRestart.Size = new Size(146, 36);
            btnSaveRestart.Click += delegate
            {
                SaveValues();
                ShouldRestartService = true;
                DialogResult = DialogResult.OK;
                Close();
            };
            Controls.Add(btnSaveRestart);

            Button btnSaveOnly = CreateButton("仅保存", Theme.BgCard, Theme.TextPrimary, false);
            btnSaveOnly.Location = new Point(454, 514);
            btnSaveOnly.Size = new Size(96, 36);
            btnSaveOnly.Click += delegate
            {
                SaveValues();
                ShouldRestartService = false;
                DialogResult = DialogResult.OK;
                Close();
            };
            Controls.Add(btnSaveOnly);

            Button btnCancel = CreateButton("取消", Theme.BgCard, Theme.TextMuted, false);
            btnCancel.Location = new Point(560, 514);
            btnCancel.Size = new Size(96, 36);
            btnCancel.Click += delegate
            {
                DialogResult = DialogResult.Cancel;
                Close();
            };
            Controls.Add(btnCancel);
        }

        private void LoadCurrentValues()
        {
            Dictionary<string, string> current = DotEnvManager.ReadEnv(_envPath);
            if (!current.ContainsKey("CODING_AGENT_BASE_URL")) current["CODING_AGENT_BASE_URL"] = "https://dashscope.aliyuncs.com/compatible-mode/v1";
            if (!current.ContainsKey("CODING_AGENT_MODEL")) current["CODING_AGENT_MODEL"] = "qwen3-coder-plus";
            if (!current.ContainsKey("SPEECH_BASE_URL")) current["SPEECH_BASE_URL"] = "https://dashscope.aliyuncs.com/compatible-mode/v1";
            if (!current.ContainsKey("SPEECH_MODEL")) current["SPEECH_MODEL"] = "qwen3-asr-flash";
            if (!current.ContainsKey("LUX3D_BASE")) current["LUX3D_BASE"] = "https://api.aholo.cn";

            foreach (KeyValuePair<string, TextBox> kv in _inputs)
            {
                if (current.ContainsKey(kv.Key))
                {
                    kv.Value.Text = current[kv.Key];
                }
            }
        }

        private void SaveValues()
        {
            Dictionary<string, string> updates = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, TextBox> kv in _inputs)
            {
                string val = (kv.Value.Text ?? "").Trim();
                if (kv.Key == "CODING_AGENT_BASE_URL")
                {
                    val = Regex.Replace(val.TrimEnd('/'), @"/chat/completions$", "", RegexOptions.IgnoreCase);
                }
                updates[kv.Key] = val;
            }
            DotEnvManager.WriteEnv(_envPath, updates);
        }

        private static Button CreateButton(string text, Color bg, Color fg, bool bold)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.BackColor = bg;
            btn.ForeColor = fg;
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderColor = Theme.BorderSubtle;
            btn.FlatAppearance.BorderSize = 1;
            btn.Font = new Font("Microsoft YaHei UI", 9.5f, bold ? FontStyle.Bold : FontStyle.Regular);
            btn.Cursor = Cursors.Hand;
            return btn;
        }
    }

    internal sealed class FormaDesktopOptions
    {
        public string RepoRoot;
        public string NodeExe;
        public string PreferredPort;
        public string DataDir;
        public bool Ephemeral;
        public bool ShowConsoleOnStart;
        public bool NoAutoOpenWindow;
        public bool SelfTest;
        public string TestDotEnvPath;
    }

    internal sealed class FormaMainForm : Form
    {
        private readonly FormaDesktopOptions _options;
        private readonly Icon _appIcon;
        private readonly EventWaitHandle _activateEvent;
        private readonly int _selfPid;
        private IntPtr _jobHandle;
        private Process _nodeProcess;
        private Process _appWindowProcess;
        private StartupSplashForm _splashForm;
        private System.Windows.Forms.Timer _windowWatchTimer;

        private bool _allowConsoleVisible;
        private bool _isStoppingService;
        private bool _isExitingApp;
        private bool _hasAutoOpenedOnce;
        private bool _studioWindowSeen;
        private int _studioWindowMissingTicks;

        private string _studioUrl = "";
        private string _activeWorkspace = "";
        private string _codingStatus = "检测中...";
        private string _speechStatus = "检测中...";
        private string _luxStatus = "检测中...";
        private string _browserEngineName = "检测中...";
        private string _browserExePath = "";

        private Label _statusBadge;
        private Label _lblStudioValue;
        private Label _lblCodingValue;
        private Label _lblSpeechValue;
        private Label _lblLuxValue;
        private ComboBox _workspaceCombo;
        private TextBox _portInput;
        private CheckBox _chkAutoOpen;
        private CheckBox _chkExitWithAppWindow;
        private TextBox _logBox;
        private Button _btnOpenAppWindow;
        private Button _btnToggleService;
        private NotifyIcon _trayIcon;

        public FormaMainForm(FormaDesktopOptions options, Icon appIcon, EventWaitHandle activateEvent)
        {
            _options = options;
            _appIcon = appIcon;
            _activateEvent = activateEvent;
            _selfPid = Process.GetCurrentProcess().Id;
            _allowConsoleVisible = options.ShowConsoleOnStart;
            _jobHandle = NativeMethods.CreateKillOnCloseJob();
            ResolveBrowserEngine();

            Text = "Forma 服务控制台 (高级设置)";
            Size = new Size(920, 660);
            MinimumSize = new Size(860, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Theme.BgCanvas;
            ForeColor = Theme.TextPrimary;
            ShowInTaskbar = _allowConsoleVisible;
            Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            if (_appIcon != null) Icon = _appIcon;

            BuildUi();
            BuildTrayIcon();
            BuildWindowWatchTimer();
            StartSingleInstanceActivationListener();

            // Create handle immediately so BeginInvoke works even when console is hidden in tray
            IntPtr dummy = Handle;
            if (!_allowConsoleVisible)
            {
                ShowSplash();
            }
            StartFormaService();
        }

        protected override void SetVisibleCore(bool value)
        {
            if (!_allowConsoleVisible && value)
            {
                base.SetVisibleCore(false);
                return;
            }
            base.SetVisibleCore(value);
        }

        private void ShowSplash()
        {
            if (_splashForm != null && !_splashForm.IsDisposed) return;
            _splashForm = new StartupSplashForm(_appIcon);
            _splashForm.Show();
            _splashForm.Refresh();
        }

        private void CloseSplash()
        {
            if (_splashForm != null)
            {
                try
                {
                    if (!_splashForm.IsDisposed) _splashForm.Close();
                    _splashForm.Dispose();
                }
                catch
                {
                }
                _splashForm = null;
            }
        }

        public void ShowConsoleWindow()
        {
            _allowConsoleVisible = true;
            ShowInTaskbar = true;
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
            NativeMethods.SetForegroundWindow(Handle);
        }

        public void HideConsoleToTray()
        {
            _allowConsoleVisible = false;
            ShowInTaskbar = false;
            Hide();
        }

        private void BuildWindowWatchTimer()
        {
            _windowWatchTimer = new System.Windows.Forms.Timer();
            _windowWatchTimer.Interval = 500;
            _windowWatchTimer.Tick += OnWindowWatchTick;
            _windowWatchTimer.Start();
        }

        private void OnWindowWatchTick(object sender, EventArgs e)
        {
            if (_isExitingApp || _isStoppingService) return;
            if (string.IsNullOrEmpty(_studioUrl)) return;

            IntPtr studioHwnd = NativeMethods.FindStudioAppWindow(_selfPid);
            if (studioHwnd != IntPtr.Zero)
            {
                _studioWindowSeen = true;
                _studioWindowMissingTicks = 0;
                CloseSplash();
            }
            else if (_studioWindowSeen)
            {
                _studioWindowMissingTicks++;
                // Wait 2 consecutive checks (1s) to confirm the user closed the Studio window
                if (_studioWindowMissingTicks >= 2)
                {
                    _studioWindowSeen = false;
                    if (_chkExitWithAppWindow != null && _chkExitWithAppWindow.Checked && !_allowConsoleVisible)
                    {
                        _isExitingApp = true;
                        ExitApplicationCleanly();
                    }
                }
            }
        }

        private void StartSingleInstanceActivationListener()
        {
            if (_activateEvent == null) return;
            Thread listener = new Thread(delegate()
            {
                while (!_isExitingApp)
                {
                    try
                    {
                        if (_activateEvent.WaitOne(1000))
                        {
                            if (_isExitingApp) break;
                            SafeInvoke(delegate
                            {
                                IntPtr studioHwnd = NativeMethods.FindStudioAppWindow(_selfPid);
                                if (studioHwnd != IntPtr.Zero)
                                {
                                    NativeMethods.FocusWindow(studioHwnd);
                                }
                                else if (!string.IsNullOrEmpty(_studioUrl))
                                {
                                    LaunchOrFocusStudioAppWindow();
                                }
                                else
                                {
                                    ShowSplash();
                                }
                            });
                        }
                    }
                    catch
                    {
                        break;
                    }
                }
            });
            listener.IsBackground = true;
            listener.Start();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            NativeMethods.EnableDarkTitleBar(Handle);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // If the user opened the advanced console and clicked X while the Studio app window is still open,
            // just hide the console back to the tray so only ONE window remains!
            if (!_isExitingApp && e.CloseReason == CloseReason.UserClosing)
            {
                IntPtr studioHwnd = NativeMethods.FindStudioAppWindow(_selfPid);
                if (studioHwnd != IntPtr.Zero)
                {
                    e.Cancel = true;
                    HideConsoleToTray();
                    return;
                }
                _isExitingApp = true;
            }

            CleanupAllResources();
            base.OnFormClosing(e);
        }

        private void ExitApplicationCleanly()
        {
            _isExitingApp = true;
            CleanupAllResources();
            Application.Exit();
        }

        private void CleanupAllResources()
        {
            if (_windowWatchTimer != null)
            {
                _windowWatchTimer.Stop();
                _windowWatchTimer.Dispose();
                _windowWatchTimer = null;
            }
            CloseSplash();
            StopFormaService();
            CloseAppWindowIfRunning();
            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
                _trayIcon.Dispose();
                _trayIcon = null;
            }
            if (_jobHandle != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_jobHandle);
                _jobHandle = IntPtr.Zero;
            }
        }

        private void ResolveBrowserEngine()
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            foreach (string c in candidates)
            {
                if (File.Exists(c))
                {
                    _browserExePath = c;
                    _browserEngineName = c.IndexOf("msedge.exe", StringComparison.OrdinalIgnoreCase) >= 0
                        ? "Microsoft Edge 独立应用窗口 (--app)"
                        : "Google Chrome 独立应用窗口 (--app)";
                    return;
                }
            }
            _browserExePath = "";
            _browserEngineName = "系统默认浏览器";
        }

        private void BuildUi()
        {
            Panel headerPanel = new Panel();
            headerPanel.BackColor = Theme.BgIsland;
            headerPanel.Location = new Point(20, 16);
            headerPanel.Size = new Size(864, 76);
            headerPanel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(headerPanel);

            Label brandBadge = new Label();
            brandBadge.Text = "FORMA";
            brandBadge.BackColor = Theme.AccentLime;
            brandBadge.ForeColor = Theme.BgCanvas;
            brandBadge.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            brandBadge.TextAlign = ContentAlignment.MiddleCenter;
            brandBadge.Location = new Point(18, 18);
            brandBadge.Size = new Size(76, 40);
            headerPanel.Controls.Add(brandBadge);

            Label titleLbl = new Label();
            titleLbl.Text = "Forma 后台服务与模型控制台";
            titleLbl.Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold);
            titleLbl.ForeColor = Theme.TextPrimary;
            titleLbl.Location = new Point(108, 14);
            titleLbl.Size = new Size(440, 26);
            headerPanel.Controls.Add(titleLbl);

            Label subTitleLbl = new Label();
            subTitleLbl.Text = "关闭本窗口将自动隐藏回右下角系统托盘，保持单一工作台窗口体验";
            subTitleLbl.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular);
            subTitleLbl.ForeColor = Theme.TextMuted;
            subTitleLbl.Location = new Point(108, 42);
            subTitleLbl.Size = new Size(500, 20);
            headerPanel.Controls.Add(subTitleLbl);

            _statusBadge = new Label();
            _statusBadge.Text = "● 正在初始化...";
            _statusBadge.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            _statusBadge.ForeColor = Theme.StatusWarn;
            _statusBadge.BackColor = Theme.BgCard;
            _statusBadge.TextAlign = ContentAlignment.MiddleCenter;
            _statusBadge.Location = new Point(648, 20);
            _statusBadge.Size = new Size(198, 36);
            _statusBadge.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            headerPanel.Controls.Add(_statusBadge);

            Panel actionBar = new Panel();
            actionBar.BackColor = Theme.BgIsland;
            actionBar.Location = new Point(20, 102);
            actionBar.Size = new Size(864, 54);
            actionBar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(actionBar);

            _btnOpenAppWindow = CreateStyledButton("打开 / 聚焦工作台窗口", Theme.AccentLime, Theme.BgCanvas, true);
            _btnOpenAppWindow.Location = new Point(14, 9);
            _btnOpenAppWindow.Size = new Size(176, 36);
            _btnOpenAppWindow.Enabled = false;
            _btnOpenAppWindow.Click += delegate
            {
                LaunchOrFocusStudioAppWindow();
                HideConsoleToTray();
            };
            actionBar.Controls.Add(_btnOpenAppWindow);

            Button btnOpenBrowser = CreateStyledButton("在浏览器中打开", Theme.BgCard, Theme.TextPrimary, false);
            btnOpenBrowser.Location = new Point(200, 9);
            btnOpenBrowser.Size = new Size(132, 36);
            btnOpenBrowser.Click += delegate
            {
                if (!string.IsNullOrEmpty(_studioUrl))
                {
                    try { Process.Start(_studioUrl); } catch { }
                }
            };
            actionBar.Controls.Add(btnOpenBrowser);

            Button btnConfigModels = CreateStyledButton("模型与密钥设置", Theme.BgCard, Theme.AccentLime, true);
            btnConfigModels.Location = new Point(342, 9);
            btnConfigModels.Size = new Size(142, 36);
            btnConfigModels.Click += delegate { OpenModelConfigDialog(); };
            actionBar.Controls.Add(btnConfigModels);

            Button btnRestart = CreateStyledButton("重启本地服务", Theme.BgCard, Theme.TextPrimary, false);
            btnRestart.Location = new Point(494, 9);
            btnRestart.Size = new Size(122, 36);
            btnRestart.Click += delegate { RestartFormaService(); };
            actionBar.Controls.Add(btnRestart);

            _btnToggleService = CreateStyledButton("停止服务", Theme.BgCard, Theme.StatusErr, false);
            _btnToggleService.Location = new Point(626, 9);
            _btnToggleService.Size = new Size(104, 36);
            _btnToggleService.Click += delegate
            {
                if (_nodeProcess != null && !_nodeProcess.HasExited)
                {
                    StopFormaService();
                }
                else
                {
                    StartFormaService();
                }
            };
            actionBar.Controls.Add(_btnToggleService);

            Button btnQuitAll = CreateStyledButton("完全退出", Theme.BgCard, Theme.StatusErr, false);
            btnQuitAll.Location = new Point(740, 9);
            btnQuitAll.Size = new Size(112, 36);
            btnQuitAll.Click += delegate { ExitApplicationCleanly(); };
            actionBar.Controls.Add(btnQuitAll);

            Panel cardStudio = CreateTelemetryCard("工作台地址与窗口引擎", "等待服务就绪...", out _lblStudioValue, 20, 166, 424, 68);
            cardStudio.Anchor = AnchorStyles.Top | AnchorStyles.Left;
            Controls.Add(cardStudio);

            Panel cardCoding = CreateTelemetryCard("代码生成模型 (Coding Agent)", _codingStatus, out _lblCodingValue, 460, 166, 424, 68);
            cardCoding.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(cardCoding);

            Panel cardSpeech = CreateTelemetryCard("语音识别模型 (Speech ASR)", _speechStatus, out _lblSpeechValue, 20, 244, 424, 68);
            cardSpeech.Anchor = AnchorStyles.Top | AnchorStyles.Left;
            Controls.Add(cardSpeech);

            Panel cardLux = CreateTelemetryCard("3D 空间资产引擎 (Lux3D)", _luxStatus, out _lblLuxValue, 460, 244, 424, 68);
            cardLux.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(cardLux);

            Panel wsPanel = new Panel();
            wsPanel.BackColor = Theme.BgIsland;
            wsPanel.Location = new Point(20, 322);
            wsPanel.Size = new Size(864, 78);
            wsPanel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(wsPanel);

            Label lblWs = new Label();
            lblWs.Text = "作品工作区:";
            lblWs.ForeColor = Theme.TextPrimary;
            lblWs.Location = new Point(14, 14);
            lblWs.Size = new Size(82, 24);
            wsPanel.Controls.Add(lblWs);

            _workspaceCombo = new ComboBox();
            _workspaceCombo.DropDownStyle = ComboBoxStyle.DropDownList;
            _workspaceCombo.BackColor = Theme.BgInput;
            _workspaceCombo.ForeColor = Theme.TextPrimary;
            _workspaceCombo.FlatStyle = FlatStyle.Flat;
            _workspaceCombo.Location = new Point(98, 11);
            _workspaceCombo.Size = new Size(270, 28);
            _workspaceCombo.Items.Add("日常创作工作区 (.data/forma)");
            _workspaceCombo.Items.Add("空间画布试用工作区 (.data/studio-pilot)");
            _workspaceCombo.Items.Add("临时隔离沙箱 (--ephemeral)");
            _workspaceCombo.Items.Add("自定义工作区目录...");
            _workspaceCombo.SelectedIndex = _options.Ephemeral ? 2 : 0;
            _workspaceCombo.SelectedIndexChanged += OnWorkspaceSelectionChanged;
            wsPanel.Controls.Add(_workspaceCombo);

            Button btnOpenFolder = CreateStyledButton("打开作品目录", Theme.BgCard, Theme.TextPrimary, false);
            btnOpenFolder.Location = new Point(378, 9);
            btnOpenFolder.Size = new Size(116, 30);
            btnOpenFolder.Click += delegate
            {
                string dir = !string.IsNullOrEmpty(_activeWorkspace)
                    ? _activeWorkspace
                    : Path.Combine(_options.RepoRoot, @".data\forma");
                if (Directory.Exists(dir))
                {
                    try { Process.Start("explorer.exe", "\"" + dir + "\""); } catch { }
                }
            };
            wsPanel.Controls.Add(btnOpenFolder);

            Label lblPort = new Label();
            lblPort.Text = "首选端口:";
            lblPort.ForeColor = Theme.TextMuted;
            lblPort.Location = new Point(512, 14);
            lblPort.Size = new Size(68, 24);
            wsPanel.Controls.Add(lblPort);

            _portInput = new TextBox();
            _portInput.Text = string.IsNullOrEmpty(_options.PreferredPort) ? "5173" : _options.PreferredPort;
            _portInput.BackColor = Theme.BgInput;
            _portInput.ForeColor = Theme.TextPrimary;
            _portInput.BorderStyle = BorderStyle.FixedSingle;
            _portInput.Location = new Point(582, 11);
            _portInput.Size = new Size(64, 24);
            wsPanel.Controls.Add(_portInput);

            _chkAutoOpen = new CheckBox();
            _chkAutoOpen.Text = "服务就绪后自动弹出独立工作台窗口";
            _chkAutoOpen.ForeColor = Theme.TextMuted;
            _chkAutoOpen.Checked = !_options.NoAutoOpenWindow;
            _chkAutoOpen.Location = new Point(16, 46);
            _chkAutoOpen.Size = new Size(280, 24);
            wsPanel.Controls.Add(_chkAutoOpen);

            _chkExitWithAppWindow = new CheckBox();
            _chkExitWithAppWindow.Text = "关闭工作台窗口时同步退出后台服务";
            _chkExitWithAppWindow.ForeColor = Theme.TextMuted;
            _chkExitWithAppWindow.Checked = true;
            _chkExitWithAppWindow.Location = new Point(316, 46);
            _chkExitWithAppWindow.Size = new Size(360, 24);
            wsPanel.Controls.Add(_chkExitWithAppWindow);

            Label lblLogs = new Label();
            lblLogs.Text = "本地服务实时运行日志 (Backend Fastify + Studio Vite + Main Preview)";
            lblLogs.ForeColor = Theme.TextMuted;
            lblLogs.Location = new Point(20, 408);
            lblLogs.Size = new Size(560, 20);
            Controls.Add(lblLogs);

            _logBox = new TextBox();
            _logBox.Multiline = true;
            _logBox.ReadOnly = true;
            _logBox.ScrollBars = ScrollBars.Vertical;
            _logBox.BackColor = Theme.BgIsland;
            _logBox.ForeColor = Theme.TextPrimary;
            _logBox.BorderStyle = BorderStyle.FixedSingle;
            _logBox.Font = new Font("Consolas", 9f, FontStyle.Regular);
            _logBox.Location = new Point(20, 432);
            _logBox.Size = new Size(864, 174);
            _logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(_logBox);
        }

        private void BuildTrayIcon()
        {
            ContextMenu trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add("打开 Forma 空间工作台", delegate { LaunchOrFocusStudioAppWindow(); });
            trayMenu.MenuItems.Add("模型与密钥设置 (apps/server/.env)...", delegate { OpenModelConfigDialog(); });
            trayMenu.MenuItems.Add("高级服务控制台与日志...", delegate { ShowConsoleWindow(); });
            trayMenu.MenuItems.Add("-");
            trayMenu.MenuItems.Add("打开当前作品数据目录", delegate
            {
                string dir = !string.IsNullOrEmpty(_activeWorkspace)
                    ? _activeWorkspace
                    : Path.Combine(_options.RepoRoot, @".data\forma");
                if (Directory.Exists(dir))
                {
                    try { Process.Start("explorer.exe", "\"" + dir + "\""); } catch { }
                }
            });
            trayMenu.MenuItems.Add("重启本地服务", delegate { RestartFormaService(); });
            trayMenu.MenuItems.Add("-");
            trayMenu.MenuItems.Add("完全退出 Forma", delegate { ExitApplicationCleanly(); });

            _trayIcon = new NotifyIcon();
            _trayIcon.Text = "Forma 空间化 AI 创作工作台 (右键设置/退出)";
            _trayIcon.Icon = _appIcon ?? SystemIcons.Application;
            _trayIcon.ContextMenu = trayMenu;
            _trayIcon.Visible = true;
            _trayIcon.DoubleClick += delegate { LaunchOrFocusStudioAppWindow(); };
        }

        private Panel CreateTelemetryCard(string title, string initialVal, out Label valueLabel, int x, int y, int w, int h)
        {
            Panel p = new Panel();
            p.BackColor = Theme.BgCard;
            p.Location = new Point(x, y);
            p.Size = new Size(w, h);

            Label t = new Label();
            t.Text = title;
            t.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Regular);
            t.ForeColor = Theme.TextMuted;
            t.Location = new Point(14, 10);
            t.Size = new Size(w - 28, 18);
            p.Controls.Add(t);

            valueLabel = new Label();
            valueLabel.Text = initialVal;
            valueLabel.Font = new Font("Consolas", 9.5f, FontStyle.Bold);
            valueLabel.ForeColor = Theme.TextPrimary;
            valueLabel.Location = new Point(14, 32);
            valueLabel.Size = new Size(w - 28, 24);
            p.Controls.Add(valueLabel);

            return p;
        }

        private static Button CreateStyledButton(string text, Color bg, Color fg, bool bold)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.BackColor = bg;
            btn.ForeColor = fg;
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderColor = Theme.BorderSubtle;
            btn.FlatAppearance.BorderSize = 1;
            btn.Font = new Font("Microsoft YaHei UI", 9f, bold ? FontStyle.Bold : FontStyle.Regular);
            btn.Cursor = Cursors.Hand;
            return btn;
        }

        private void OnWorkspaceSelectionChanged(object sender, EventArgs e)
        {
            int idx = _workspaceCombo.SelectedIndex;
            if (idx == 0)
            {
                _options.Ephemeral = false;
                _options.DataDir = Path.Combine(_options.RepoRoot, @".data\forma");
                if (_portInput.Text == "5183") _portInput.Text = "5173";
            }
            else if (idx == 1)
            {
                _options.Ephemeral = false;
                _options.DataDir = Path.Combine(_options.RepoRoot, @".data\studio-pilot");
                if (_portInput.Text == "5173") _portInput.Text = "5183";
            }
            else if (idx == 2)
            {
                _options.Ephemeral = true;
            }
            else if (idx == 3)
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.Description = "选择 Forma 作品数据持久化目录 (FORMA_DATA_DIR)";
                    fbd.SelectedPath = !string.IsNullOrEmpty(_options.DataDir) ? _options.DataDir : _options.RepoRoot;
                    if (fbd.ShowDialog(this) == DialogResult.OK && !string.IsNullOrEmpty(fbd.SelectedPath))
                    {
                        _options.Ephemeral = false;
                        _options.DataDir = fbd.SelectedPath;
                    }
                    else
                    {
                        return;
                    }
                }
            }

            if (_nodeProcess != null && !_nodeProcess.HasExited)
            {
                AppendLog("[客户端] 工作区已切换，正在重启本地服务...");
                RestartFormaService();
            }
        }

        private void OpenModelConfigDialog()
        {
            string envPath = Path.Combine(_options.RepoRoot, @"apps\server\.env");
            using (EnvConfigDialog dlg = new EnvConfigDialog(envPath, _appIcon))
            {
                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    AppendLog("[客户端] 已更新 apps/server/.env 模型配置。");
                    if (dlg.ShouldRestartService)
                    {
                        RestartFormaService();
                    }
                }
            }
        }

        public void StartFormaService()
        {
            if (_nodeProcess != null && !_nodeProcess.HasExited) return;

            _isStoppingService = false;
            _studioUrl = "";
            _studioWindowSeen = false;
            _studioWindowMissingTicks = 0;
            UpdateStatusBadge("● 正在启动服务...", Theme.StatusWarn);
            _btnOpenAppWindow.Enabled = false;
            _btnToggleService.Text = "停止服务";
            _btnToggleService.ForeColor = Theme.StatusErr;

            string startScript = Path.Combine(_options.RepoRoot, @"scripts\forma\start.mjs");
            if (!File.Exists(startScript))
            {
                CloseSplash();
                UpdateStatusBadge("● 启动脚本缺失", Theme.StatusErr);
                AppendLog("[错误] 未找到启动脚本: " + startScript);
                ShowConsoleWindow();
                return;
            }

            string args = "\"" + startScript + "\"";
            if (_options.Ephemeral)
            {
                args += " --ephemeral";
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = _options.NodeExe;
            psi.Arguments = args;
            psi.WorkingDirectory = _options.RepoRoot;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            psi.EnvironmentVariables["FORMA_DESKTOP_STDIN_SHUTDOWN"] = "1";
            string portText = (_portInput.Text ?? "").Trim();
            if (!string.IsNullOrEmpty(portText))
            {
                psi.EnvironmentVariables["FORMA_PORT"] = portText;
            }
            if (!_options.Ephemeral && !string.IsNullOrEmpty(_options.DataDir))
            {
                psi.EnvironmentVariables["FORMA_DATA_DIR"] = _options.DataDir;
            }

            try
            {
                AppendLog("[客户端] 正在启动本地服务: " + _options.NodeExe + " " + args);
                Process proc = new Process();
                proc.StartInfo = psi;
                proc.EnableRaisingEvents = true;
                proc.OutputDataReceived += OnNodeOutputLine;
                proc.ErrorDataReceived += OnNodeErrorLine;
                proc.Exited += OnNodeExited;

                proc.Start();
                if (_jobHandle != IntPtr.Zero)
                {
                    NativeMethods.AssignProcessToJobObject(_jobHandle, proc.Handle);
                }
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                _nodeProcess = proc;
            }
            catch (Exception ex)
            {
                CloseSplash();
                UpdateStatusBadge("● 启动失败", Theme.StatusErr);
                AppendLog("[错误] 无法启动 Node 进程: " + ex.Message);
                ShowConsoleWindow();
            }
        }

        public void StopFormaService()
        {
            Process proc = _nodeProcess;
            if (proc == null) return;

            _isStoppingService = true;
            _nodeProcess = null;

            try
            {
                if (!proc.HasExited)
                {
                    AppendLog("[客户端] 正在向本地服务发送优雅关闭指令...");
                    try
                    {
                        proc.StandardInput.WriteLine("shutdown");
                        proc.StandardInput.Flush();
                        proc.StandardInput.Close();
                    }
                    catch
                    {
                    }

                    if (!proc.WaitForExit(6000))
                    {
                        KillProcessTree(proc.Id);
                    }
                }
            }
            catch
            {
            }
            finally
            {
                try { proc.Dispose(); } catch { }
            }

            SafeInvoke(delegate
            {
                UpdateStatusBadge("● 服务已停止", Theme.TextMuted);
                _btnOpenAppWindow.Enabled = false;
                _btnToggleService.Text = "启动服务";
                _btnToggleService.ForeColor = Theme.AccentLime;
            });
        }

        public void RestartFormaService()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                StopFormaService();
                Thread.Sleep(350);
                SafeInvoke(delegate
                {
                    _hasAutoOpenedOnce = false;
                    StartFormaService();
                });
            });
        }

        private static void KillProcessTree(int pid)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/F /T /PID " + pid);
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                using (Process killer = Process.Start(psi))
                {
                    if (killer != null) killer.WaitForExit(3000);
                }
            }
            catch
            {
            }
        }

        private void OnNodeOutputLine(object sender, DataReceivedEventArgs e)
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            string line = e.Data;
            AppendLog(line);

            if (line.StartsWith("Forma Studio=", StringComparison.Ordinal))
            {
                Match m = Regex.Match(line, @"Forma Studio=(http://127\.0\.0\.1:\d+);\s*workspace=(.+)$");
                if (m.Success)
                {
                    string url = m.Groups[1].Value.Trim();
                    string ws = m.Groups[2].Value.Trim();
                    SafeInvoke(delegate
                    {
                        _studioUrl = url;
                        _activeWorkspace = ws;
                        _lblStudioValue.Text = url + " (" + _browserEngineName + ")";
                        _lblStudioValue.ForeColor = Theme.AccentLime;
                        UpdateStatusBadge("● 运行中 · " + url.Replace("http://", ""), Theme.StatusOk);
                        _btnOpenAppWindow.Enabled = true;

                        if (_chkAutoOpen.Checked && !_hasAutoOpenedOnce)
                        {
                            _hasAutoOpenedOnce = true;
                            LaunchOrFocusStudioAppWindow(true);
                        }
                        CloseSplash();
                    });
                }
            }
            else if (line.StartsWith("Connected models:", StringComparison.Ordinal))
            {
                Match mc = Regex.Match(line, @"coding=([^;]+)");
                Match ms = Regex.Match(line, @"speech=([^;]+)");
                Match ml = Regex.Match(line, @"lux3d=([^;]+)");
                SafeInvoke(delegate
                {
                    if (mc.Success) ApplyModelCard(_lblCodingValue, mc.Groups[1].Value.Trim());
                    if (ms.Success) ApplyModelCard(_lblSpeechValue, ms.Groups[1].Value.Trim());
                    if (ml.Success) ApplyModelCard(_lblLuxValue, ml.Groups[1].Value.Trim());
                });
            }
        }

        private static void ApplyModelCard(Label lbl, string rawVal)
        {
            if (string.Equals(rawVal, "unconfigured", StringComparison.OrdinalIgnoreCase))
            {
                lbl.Text = "未配置 (右键托盘图标 -> 模型与密钥设置)";
                lbl.ForeColor = Theme.StatusWarn;
            }
            else
            {
                lbl.Text = rawVal;
                lbl.ForeColor = Theme.StatusOk;
            }
        }

        private void OnNodeErrorLine(object sender, DataReceivedEventArgs e)
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            AppendLog("[stderr] " + e.Data);
        }

        private void OnNodeExited(object sender, EventArgs e)
        {
            if (_isStoppingService || _isExitingApp) return;
            SafeInvoke(delegate
            {
                CloseSplash();
                UpdateStatusBadge("● 服务异常退出", Theme.StatusErr);
                _btnOpenAppWindow.Enabled = false;
                _btnToggleService.Text = "启动服务";
                _btnToggleService.ForeColor = Theme.AccentLime;
                AppendLog("[警告] 本地服务进程已退出。可点击「启动服务」或检查日志。");
                ShowConsoleWindow();
            });
        }

        public void LaunchOrFocusStudioAppWindow()
        {
            LaunchOrFocusStudioAppWindow(false);
        }

        public void LaunchOrFocusStudioAppWindow(bool isFreshServiceStart)
        {
            if (string.IsNullOrEmpty(_studioUrl)) return;

            IntPtr existingHwnd = NativeMethods.FindStudioAppWindow(_selfPid);
            if (existingHwnd != IntPtr.Zero)
            {
                if (isFreshServiceStart)
                {
                    try { NativeMethods.PostMessage(existingHwnd, NativeMethods.WM_CLOSE, IntPtr.Zero, IntPtr.Zero); } catch { }
                    Thread.Sleep(200);
                }
                else
                {
                    NativeMethods.FocusWindow(existingHwnd);
                    return;
                }
            }

            if (string.IsNullOrEmpty(_browserExePath) || !File.Exists(_browserExePath))
            {
                try { Process.Start(_studioUrl); } catch { }
                return;
            }

            string profileRoot = !string.IsNullOrEmpty(_activeWorkspace)
                ? Path.Combine(_activeWorkspace, ".desktop-window-profile")
                : Path.Combine(_options.RepoRoot, @".data\desktop-window-profile");

            try
            {
                if (!Directory.Exists(profileRoot)) Directory.CreateDirectory(profileRoot);
                string firstRunSentinel = Path.Combine(profileRoot, "First Run");
                if (!File.Exists(firstRunSentinel))
                {
                    File.WriteAllText(firstRunSentinel, "", Encoding.ASCII);
                }

                string browserArgs = string.Format(
                    "--app=\"{0}\" --user-data-dir=\"{1}\" --new-window --window-size=1440,920 --no-first-run --no-default-browser-check --disable-sync --disable-features=Translate,msEdgeSidebarV2,msEdgeWelcomePage",
                    _studioUrl,
                    profileRoot
                );

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = _browserExePath;
                psi.Arguments = browserArgs;
                psi.UseShellExecute = false;

                Process browserProc = new Process();
                browserProc.StartInfo = psi;
                browserProc.Start();
                _appWindowProcess = browserProc;

                AppendLog("[客户端] 已打开工作台窗口: " + _studioUrl);
            }
            catch (Exception ex)
            {
                AppendLog("[客户端] 独立窗口启动失败，回退至默认浏览器: " + ex.Message);
                try { Process.Start(_studioUrl); } catch { }
            }
        }

        private void CloseAppWindowIfRunning()
        {
            try
            {
                IntPtr studioHwnd = NativeMethods.FindStudioAppWindow(_selfPid);
                if (studioHwnd != IntPtr.Zero)
                {
                    NativeMethods.PostMessage(studioHwnd, NativeMethods.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                }
            }
            catch
            {
            }

            Process proc = _appWindowProcess;
            _appWindowProcess = null;
            if (proc == null) return;
            try
            {
                if (!proc.HasExited)
                {
                    proc.CloseMainWindow();
                    if (!proc.WaitForExit(1500))
                    {
                        try { proc.Kill(); } catch { }
                    }
                }
            }
            catch
            {
            }
            finally
            {
                try { proc.Dispose(); } catch { }
            }
        }

        private void UpdateStatusBadge(string text, Color color)
        {
            if (_statusBadge != null)
            {
                _statusBadge.Text = text;
                _statusBadge.ForeColor = color;
            }
        }

        private void AppendLog(string message)
        {
            SafeInvoke(delegate
            {
                if (_logBox == null || _logBox.IsDisposed) return;
                string ts = DateTime.Now.ToString("HH:mm:ss");
                _logBox.AppendText("[" + ts + "] " + message + Environment.NewLine);
            });
        }

        private void SafeInvoke(MethodInvoker action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(action); } catch { }
            }
            else
            {
                action();
            }
        }
    }

    internal static class SelfTestRunner
    {
        public static int RunDotEnvTest(string envPath)
        {
            try
            {
                Dictionary<string, string> before = DotEnvManager.ReadEnv(envPath);
                Dictionary<string, string> updates = new Dictionary<string, string>(StringComparer.Ordinal);
                updates["CODING_AGENT_BASE_URL"] = "https://coding.dashscope.aliyuncs.com/v1";
                updates["CODING_AGENT_MODEL"] = "qwen3-coder-plus";
                updates["CODING_AGENT_API_KEY"] = "test-placeholder-key-not-real";
                updates["SPEECH_MODEL"] = "qwen3-asr-flash";
                DotEnvManager.WriteEnv(envPath, updates);

                byte[] rawBytes = File.ReadAllBytes(envPath);
                bool hasBom = rawBytes.Length >= 3 && rawBytes[0] == 0xEF && rawBytes[1] == 0xBB && rawBytes[2] == 0xBF;
                if (hasBom)
                {
                    Console.Error.WriteLine("[FORMA_DOTENV_TEST_FAIL] Written .env file contains UTF-8 BOM");
                    return 1;
                }

                Dictionary<string, string> after = DotEnvManager.ReadEnv(envPath);
                if (!after.ContainsKey("CODING_AGENT_MODEL") || after["CODING_AGENT_MODEL"] != "qwen3-coder-plus")
                {
                    Console.Error.WriteLine("[FORMA_DOTENV_TEST_FAIL] CODING_AGENT_MODEL mismatch");
                    return 2;
                }
                if (before.ContainsKey("CUSTOM_PRESERVED_VAR") && (!after.ContainsKey("CUSTOM_PRESERVED_VAR") || after["CUSTOM_PRESERVED_VAR"] != before["CUSTOM_PRESERVED_VAR"]))
                {
                    Console.Error.WriteLine("[FORMA_DOTENV_TEST_FAIL] Custom variable was not preserved");
                    return 3;
                }

                Console.WriteLine("[FORMA_DOTENV_TEST_PASS] {\"noBom\":true,\"keysCount\":" + after.Count + "}");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[FORMA_DOTENV_TEST_FAIL] " + ex.Message);
                return 4;
            }
        }

        public static int Run(FormaDesktopOptions options)
        {
            Stopwatch sw = Stopwatch.StartNew();
            IntPtr job = NativeMethods.CreateKillOnCloseJob();
            Process proc = null;

            try
            {
                string startScript = Path.Combine(options.RepoRoot, @"scripts\forma\start.mjs");
                if (!File.Exists(startScript))
                {
                    Console.Error.WriteLine("[FORMA_SELF_TEST_FAIL] Missing scripts/forma/start.mjs");
                    return 1;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = options.NodeExe;
                psi.Arguments = "\"" + startScript + "\" --ephemeral";
                psi.WorkingDirectory = options.RepoRoot;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardInput = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.EnvironmentVariables["FORMA_DESKTOP_STDIN_SHUTDOWN"] = "1";
                psi.EnvironmentVariables["FORMA_PORT"] = "0";

                ManualResetEventSlim readyEvent = new ManualResetEventSlim(false);
                string studioUrl = null;
                string workspacePath = null;
                StringBuilder stderrBuf = new StringBuilder();

                proc = new Process();
                proc.StartInfo = psi;
                proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (string.IsNullOrEmpty(e.Data)) return;
                    Match m = Regex.Match(e.Data, @"Forma Studio=(http://127\.0\.0\.1:\d+);\s*workspace=(.+)$");
                    if (m.Success)
                    {
                        studioUrl = m.Groups[1].Value.Trim();
                        workspacePath = m.Groups[2].Value.Trim();
                        readyEvent.Set();
                    }
                };
                proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (!string.IsNullOrEmpty(e.Data)) stderrBuf.AppendLine(e.Data);
                };

                proc.Start();
                if (job != IntPtr.Zero)
                {
                    NativeMethods.AssignProcessToJobObject(job, proc.Handle);
                }
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                if (!readyEvent.Wait(45000) || string.IsNullOrEmpty(studioUrl))
                {
                    Console.Error.WriteLine("[FORMA_SELF_TEST_FAIL] Timeout waiting for Forma Studio readiness. Stderr: " + stderrBuf);
                    return 2;
                }

                int healthStatus = 0;
                int worksStatus = 0;
                int faviconStatus = 0;
                using (HttpClient client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(10);
                    HttpResponseMessage respHealth = client.GetAsync(studioUrl + "/health").GetAwaiter().GetResult();
                    healthStatus = (int)respHealth.StatusCode;

                    HttpResponseMessage respWorks = client.GetAsync(studioUrl + "/works").GetAwaiter().GetResult();
                    worksStatus = (int)respWorks.StatusCode;

                    HttpResponseMessage respIcon = client.GetAsync(studioUrl + "/favicon.ico").GetAwaiter().GetResult();
                    faviconStatus = (int)respIcon.StatusCode;
                }

                if (healthStatus != 200 || worksStatus != 200 || faviconStatus != 200)
                {
                    Console.Error.WriteLine(string.Format(
                        "[FORMA_SELF_TEST_FAIL] Unexpected HTTP status health={0} works={1} favicon={2}",
                        healthStatus, worksStatus, faviconStatus
                    ));
                    return 3;
                }

                int nodePid = proc.Id;
                Stopwatch shutdownSw = Stopwatch.StartNew();
                proc.StandardInput.WriteLine("shutdown");
                proc.StandardInput.Flush();
                proc.StandardInput.Close();

                bool exitedGracefully = proc.WaitForExit(8000);
                shutdownSw.Stop();

                if (!exitedGracefully)
                {
                    Console.Error.WriteLine("[FORMA_SELF_TEST_FAIL] Node child did not exit within 8000ms after stdin shutdown.");
                    return 4;
                }

                sw.Stop();
                Console.WriteLine(string.Format(
                    "[FORMA_SELF_TEST_PASS] {{\"studioUrl\":\"{0}\",\"nodePid\":{1},\"healthStatus\":{2},\"worksStatus\":{3},\"faviconStatus\":{4},\"shutdownMs\":{5},\"totalMs\":{6}}}",
                    studioUrl, nodePid, healthStatus, worksStatus, faviconStatus, shutdownSw.ElapsedMilliseconds, sw.ElapsedMilliseconds
                ));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[FORMA_SELF_TEST_FAIL] Exception: " + ex.Message);
                return 5;
            }
            finally
            {
                if (proc != null)
                {
                    try { if (!proc.HasExited) proc.Kill(); } catch { }
                    try { proc.Dispose(); } catch { }
                }
                if (job != IntPtr.Zero)
                {
                    NativeMethods.CloseHandle(job);
                }
            }
        }
    }

    internal static class Program
    {
        private static string ResolveRepoRoot()
        {
            string envRoot = Environment.GetEnvironmentVariable("FORMA_REPO_ROOT");
            if (!string.IsNullOrEmpty(envRoot) && File.Exists(Path.Combine(envRoot, @"scripts\forma\start.mjs")))
            {
                return Path.GetFullPath(envRoot);
            }

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            DirectoryInfo dir = new DirectoryInfo(baseDir);
            for (int i = 0; i < 6 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir.FullName, @"scripts\forma\start.mjs")))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }

            string cwd = Directory.GetCurrentDirectory();
            if (File.Exists(Path.Combine(cwd, @"scripts\forma\start.mjs")))
            {
                return Path.GetFullPath(cwd);
            }

            return baseDir;
        }

        private static string ResolveNodeExe()
        {
            string envNode = Environment.GetEnvironmentVariable("FORMA_NODE_EXE");
            if (!string.IsNullOrEmpty(envNode) && File.Exists(envNode)) return envNode;

            string[] knownLocations = new string[]
            {
                @"E:\Node\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe")
            };
            foreach (string loc in knownLocations)
            {
                if (File.Exists(loc)) return loc;
            }

            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string segment in pathEnv.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(segment)) continue;
                try
                {
                    string candidate = Path.Combine(segment.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                }
            }
            return "node.exe";
        }

        [STAThread]
        public static int Main(string[] args)
        {
            try { NativeMethods.SetProcessDPIAware(); } catch { }

            string repoRoot = ResolveRepoRoot();
            FormaDesktopOptions options = new FormaDesktopOptions();
            options.RepoRoot = repoRoot;
            options.NodeExe = ResolveNodeExe();
            options.PreferredPort = Environment.GetEnvironmentVariable("FORMA_PORT") ?? "5173";
            options.DataDir = Environment.GetEnvironmentVariable("FORMA_DATA_DIR") ?? Path.Combine(repoRoot, @".data\forma");
            options.Ephemeral = false;
            options.ShowConsoleOnStart = false;
            options.NoAutoOpenWindow = false;
            options.SelfTest = false;
            options.TestDotEnvPath = null;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--self-test") options.SelfTest = true;
                else if (a == "--test-dotenv" && i + 1 < args.Length) { options.TestDotEnvPath = args[++i]; }
                else if (a == "--console") options.ShowConsoleOnStart = true;
                else if (a == "--ephemeral") options.Ephemeral = true;
                else if (a == "--no-open") options.NoAutoOpenWindow = true;
                else if (a == "--port" && i + 1 < args.Length) { options.PreferredPort = args[++i]; }
                else if (a == "--data-dir" && i + 1 < args.Length) { options.DataDir = args[++i]; }
            }

            if (!string.IsNullOrEmpty(options.TestDotEnvPath))
            {
                return SelfTestRunner.RunDotEnvTest(options.TestDotEnvPath);
            }

            if (options.SelfTest)
            {
                return SelfTestRunner.Run(options);
            }

            bool createdNew;
            using (Mutex singleInstanceMutex = new Mutex(true, @"Local\FormaSpatialWorkbenchDesktopClientMutex", out createdNew))
            using (EventWaitHandle activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\FormaSpatialWorkbenchDesktopActivateEvent"))
            {
                if (!createdNew)
                {
                    try { activateEvent.Set(); } catch { }
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                Icon appIcon = null;
                string icoPath = Path.Combine(repoRoot, @"desktop\assets\forma.ico");
                if (File.Exists(icoPath))
                {
                    try { appIcon = new Icon(icoPath); } catch { }
                }

                Application.Run(new FormaMainForm(options, appIcon, activateEvent));
                return 0;
            }
        }
    }
}
