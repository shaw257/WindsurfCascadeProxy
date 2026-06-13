using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("Windsurf Cascade Proxy")]
[assembly: AssemblyDescription("Route Windsurf Cascade requests to user-configured model APIs.")]
[assembly: AssemblyCompany("shaw257")]
[assembly: AssemblyProduct("Windsurf Cascade Proxy")]
[assembly: AssemblyCopyright("Copyright (c) 2026 shaw257")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]
[assembly: AssemblyInformationalVersion("0.1.0")]

namespace WindsurfCascadeProxy
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            ServicePointManager.SecurityProtocol =
                SecurityProtocolType.Tls |
                (SecurityProtocolType)768 |
                (SecurityProtocolType)3072;
            ServicePointManager.Expect100Continue = false;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    public sealed class ProxyConfig
    {
        public string upstreamProvider = "openai-compatible";
        public string openaiBaseUrl = "https://api.openai.com/v1";
        public string openaiApiKey = "";
        public string openaiModel = "gpt-5.5";
        public string openaiWireApi = "responses";
        public string thinkingMode = "default";
        public string thinkingEffort = "default";
        public int thinkingBudgetTokens = 0;
        public Dictionary<string, ModelRoute> modelRoutes = new Dictionary<string, ModelRoute>();
        public string windsurfPath = "";
        public int port = 3009;
        public bool launchWindsurfOnStart = true;
        public string localProxyToken = "local-proxy-token-placeholder";
        public int byokProxyPort = 3007;
    }

    public sealed class ModelRoute
    {
        public string baseUrl = "";
        public string apiKey = "";
        public string model = "";
        public string wireApi = "responses";
        public string thinkingMode = "";
        public string thinkingEffort = "";
        public int thinkingBudgetTokens = -1;
    }

    internal sealed class RuntimeResource
    {
        public readonly string Name;
        public readonly string RelativePath;

        public RuntimeResource(string name, string relativePath)
        {
            Name = name;
            RelativePath = relativePath;
        }
    }

    internal sealed class MainForm : Form
    {
        private static readonly RuntimeResource[] RuntimeResources = new RuntimeResource[]
        {
            new RuntimeResource("runtime.windsurf-native-proxy.mjs", "windsurf-native-proxy.mjs"),
            new RuntimeResource("runtime.windsurf-native-patch.mjs", "windsurf-native-patch.mjs"),
            new RuntimeResource("runtime.protocol.proto.js", @"windsurf-protocol-runtime\resources\proxy-scripts\src\proto.js"),
            new RuntimeResource("runtime.protocol.connect.js", @"windsurf-protocol-runtime\resources\proxy-scripts\src\connect.js"),
            new RuntimeResource("runtime.protocol.parse-request.js", @"windsurf-protocol-runtime\resources\proxy-scripts\src\handlers\parse-request.js"),
            new RuntimeResource("runtime.protocol.build-response.js", @"windsurf-protocol-runtime\resources\proxy-scripts\src\handlers\build-response.js"),
            new RuntimeResource("runtime.protocol.tool-normalization.js", @"windsurf-protocol-runtime\resources\proxy-scripts\src\handlers\tool-normalization.js")
        };

        private static readonly string[] WindsurfModelIdPresets = new string[]
        {
            "MODEL_CLAUDE_4_OPUS_BYOK",
            "MODEL_CLAUDE_4_OPUS_THINKING_BYOK",
            "MODEL_CLAUDE_4_SONNET_BYOK",
            "MODEL_CLAUDE_4_SONNET_THINKING_BYOK",
            "swe-1-6"
        };

        private const string AppVersion = "0.1.0";

        private readonly Color bg = Color.FromArgb(245, 247, 250);
        private readonly Color panelBg = Color.White;
        private readonly Color text = Color.FromArgb(24, 31, 42);
        private readonly Color muted = Color.FromArgb(96, 108, 124);
        private readonly Color border = Color.FromArgb(219, 226, 235);
        private readonly Color accent = Color.FromArgb(35, 130, 246);
        private readonly Color success = Color.FromArgb(16, 146, 89);
        private readonly Color danger = Color.FromArgb(210, 64, 64);

        private readonly string appDir;
        private readonly string runtimeDir;
        private readonly string configPath;
        private readonly string stdoutLog;
        private readonly string stderrLog;
        private readonly string appLog;

        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private ProxyConfig config;

        private TextBox baseUrlBox;
        private TextBox apiKeyBox;
        private TextBox modelBox;
        private ComboBox providerTemplateBox;
        private ComboBox wireApiBox;
        private ComboBox thinkingModeBox;
        private ComboBox thinkingEffortBox;
        private NumericUpDown thinkingBudgetBox;
        private Label thinkingModeLabel;
        private Label thinkingEffortLabel;
        private Label thinkingBudgetLabel;
        private Label thinkingHelpLabel;
        private TextBox windsurfPathBox;
        private NumericUpDown portBox;
        private CheckBox launchWindsurfBox;
        private CheckBox showKeyBox;
        private DataGridView routesGrid;
        private TextBox logBox;
        private Label statusDot;
        private Label statusTitle;
        private Label statusDetail;
        private Label protocolStatusLabel;
        private Label routeCountLabel;
        private Label patchStatusLabel;
        private Label lastRequestLabel;
        private Label runtimeLabel;
        private Button startButton;
        private Button stopButton;
        private Button refreshButton;
        private CheckBox onlyErrorLogsBox;
        private NotifyIcon trayIcon;
        private bool forceExit;

        private System.Windows.Forms.Timer healthTimer;
        private System.Windows.Forms.Timer logTimer;
        private long stdoutOffset;
        private long stderrOffset;
        private Process proxyProcess;
        private readonly object proxyLogLock = new object();
        private int healthRefreshInProgress;
        private int patchRefreshInProgress;
        private int logTailInProgress;
        private bool proxyActionInProgress;

        public MainForm()
        {
            try
            {
                Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
                Icon = SystemIcons.Application;
            }

            appDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WindsurfCascadeProxy");
            runtimeDir = Path.Combine(appDir, "Runtime");
            configPath = Path.Combine(runtimeDir, "windsurf-proxy-config.json");
            stdoutLog = Path.Combine(runtimeDir, "windsurf-proxy.stdout.log");
            stderrLog = Path.Combine(runtimeDir, "windsurf-proxy.stderr.log");
            appLog = Path.Combine(appDir, "WindsurfCascadeProxy.log");

            json.MaxJsonLength = int.MaxValue;
            Directory.CreateDirectory(appDir);
            Directory.CreateDirectory(runtimeDir);
            EnsureRuntimeFiles();
            CleanupLegacyRuntimeNames();

            config = LoadConfig();
            BuildUi();
            LoadConfigIntoUi();
            AppendLog("程序就绪。运行目录：" + runtimeDir);

            healthTimer = new System.Windows.Forms.Timer();
            healthTimer.Interval = 4000;
            healthTimer.Tick += async delegate { await RefreshHealthAsync(false); };
            healthTimer.Start();

            logTimer = new System.Windows.Forms.Timer();
            logTimer.Interval = 1500;
            logTimer.Tick += async delegate { await TailProxyLogsAsync(); };
            logTimer.Start();

            Shown += async delegate
            {
                await RefreshHealthAsync(false);
                await RefreshPatchStatusAsync(false);
            };
        }

        private void BuildUi()
        {
            Text = "Windsurf Cascade 代理 v" + AppVersion;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1180, 760);
            Size = new Size(1320, 820);
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = bg;
            Font = new Font("Segoe UI", 9.5F);
            FormClosing += MainFormClosing;
            Resize += MainFormResize;

            Panel sidebar = new Panel();
            sidebar.Dock = DockStyle.Left;
            sidebar.Width = 250;
            sidebar.BackColor = Color.FromArgb(20, 28, 41);

            Label brand = new Label();
            brand.Text = "Cascade 代理";
            brand.Font = new Font("Segoe UI Semibold", 17F, FontStyle.Bold);
            brand.ForeColor = Color.White;
            brand.Location = new Point(24, 28);
            brand.Size = new Size(210, 34);
            sidebar.Controls.Add(brand);

            Label subBrand = new Label();
            subBrand.Text = "Windsurf 原生中转";
            subBrand.ForeColor = Color.FromArgb(170, 181, 198);
            subBrand.Location = new Point(26, 66);
            subBrand.Size = new Size(210, 22);
            sidebar.Controls.Add(subBrand);

            Panel statusCard = SidebarCard(24, 118, 202, 214);
            sidebar.Controls.Add(statusCard);

            statusDot = new Label();
            statusDot.Text = "●";
            statusDot.Font = new Font("Segoe UI", 18F, FontStyle.Bold);
            statusDot.ForeColor = danger;
            statusDot.Location = new Point(14, 12);
            statusDot.Size = new Size(28, 28);
            statusCard.Controls.Add(statusDot);

            statusTitle = new Label();
            statusTitle.Text = "代理未启动";
            statusTitle.Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold);
            statusTitle.ForeColor = Color.White;
            statusTitle.Location = new Point(44, 18);
            statusTitle.Size = new Size(92, 24);
            statusCard.Controls.Add(statusTitle);

            refreshButton = SidebarMiniButton("刷新", 142, 17, 46, 24);
            refreshButton.Click += async delegate
            {
                refreshButton.Enabled = false;
                try
                {
                    await RefreshHealthAsync(true);
                    await RefreshPatchStatusAsync(true);
                }
                finally
                {
                    refreshButton.Enabled = true;
                }
            };
            statusCard.Controls.Add(refreshButton);

            statusDetail = new Label();
            statusDetail.Text = "127.0.0.1:3009";
            statusDetail.ForeColor = Color.FromArgb(171, 184, 204);
            statusDetail.Location = new Point(18, 56);
            statusDetail.Size = new Size(170, 40);
            statusDetail.AutoEllipsis = true;
            statusCard.Controls.Add(statusDetail);

            protocolStatusLabel = new Label();
            protocolStatusLabel.Text = "协议：-";
            protocolStatusLabel.ForeColor = Color.FromArgb(171, 184, 204);
            protocolStatusLabel.Location = new Point(18, 96);
            protocolStatusLabel.Size = new Size(170, 22);
            protocolStatusLabel.AutoEllipsis = true;
            statusCard.Controls.Add(protocolStatusLabel);

            routeCountLabel = new Label();
            routeCountLabel.Text = "路由：0";
            routeCountLabel.ForeColor = Color.FromArgb(171, 184, 204);
            routeCountLabel.Location = new Point(18, 120);
            routeCountLabel.Size = new Size(160, 22);
            statusCard.Controls.Add(routeCountLabel);

            patchStatusLabel = new Label();
            patchStatusLabel.Text = "补丁：未知";
            patchStatusLabel.ForeColor = Color.FromArgb(171, 184, 204);
            patchStatusLabel.Location = new Point(18, 144);
            patchStatusLabel.Size = new Size(170, 22);
            patchStatusLabel.AutoEllipsis = true;
            statusCard.Controls.Add(patchStatusLabel);

            lastRequestLabel = new Label();
            lastRequestLabel.Text = "最近请求：-";
            lastRequestLabel.ForeColor = Color.FromArgb(171, 184, 204);
            lastRequestLabel.Location = new Point(18, 168);
            lastRequestLabel.Size = new Size(170, 38);
            lastRequestLabel.AutoEllipsis = true;
            statusCard.Controls.Add(lastRequestLabel);

            startButton = PrimaryButton("启动并打开 Windsurf", 24, 350, 202, 40);
            startButton.Click += async delegate { await StartFlowAsync(); };
            sidebar.Controls.Add(startButton);

            stopButton = SecondarySidebarButton("停止代理", 24, 400, 202, 34);
            stopButton.Click += async delegate { await StopProxyAsync(); };
            sidebar.Controls.Add(stopButton);

            Button patchButton = SecondarySidebarButton("安装补丁", 24, 444, 202, 34);
            patchButton.Click += delegate { ApplyPatchFromUi(); };
            sidebar.Controls.Add(patchButton);

            Button restorePatchButton = SecondarySidebarButton("恢复补丁", 24, 488, 202, 34);
            restorePatchButton.Click += delegate { RestorePatchFromUi(); };
            sidebar.Controls.Add(restorePatchButton);

            Button folderButton = SecondarySidebarButton("打开运行目录", 24, 532, 202, 34);
            folderButton.Click += delegate { OpenFolder(runtimeDir); };
            sidebar.Controls.Add(folderButton);

            runtimeLabel = new Label();
            runtimeLabel.Text = runtimeDir;
            runtimeLabel.ForeColor = Color.FromArgb(132, 148, 170);
            runtimeLabel.Location = new Point(24, 626);
            runtimeLabel.Size = new Size(200, 84);
            runtimeLabel.AutoEllipsis = true;
            sidebar.Controls.Add(runtimeLabel);

            BuildTrayIcon();

            Panel content = new Panel();
            content.Dock = DockStyle.Fill;
            content.Padding = new Padding(26, 22, 26, 24);
            content.BackColor = bg;
            content.AutoScroll = true;
            Controls.Add(content);
            Controls.Add(sidebar);

            Label title = new Label();
            title.Text = "Windsurf 中转管理";
            title.Font = new Font("Segoe UI Semibold", 20F, FontStyle.Bold);
            title.ForeColor = text;
            title.Location = new Point(28, 22);
            title.Size = new Size(520, 40);
            content.Controls.Add(title);

            Label desc = new Label();
            desc.Text = "配置默认中转站，并按 Windsurf 内部模型 ID 路由到不同上游模型。";
            desc.ForeColor = muted;
            desc.Location = new Point(31, 64);
            desc.Size = new Size(860, 22);
            content.Controls.Add(desc);

            TabControl tabs = new TabControl();
            tabs.Location = new Point(28, 102);
            tabs.Size = new Size(980, 620);
            tabs.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            content.Controls.Add(tabs);

            TabPage providerTab = new TabPage("连接配置");
            TabPage routesTab = new TabPage("模型路由");
            TabPage logsTab = new TabPage("运行日志");
            tabs.TabPages.Add(providerTab);
            tabs.TabPages.Add(routesTab);
            tabs.TabPages.Add(logsTab);

            BuildProviderTab(providerTab);
            BuildRoutesTab(routesTab);
            BuildLogsTab(logsTab);
        }

        private void BuildProviderTab(TabPage tab)
        {
            tab.BackColor = bg;
            tab.AutoScroll = true;
            Panel card = Card(22, 24, 930, 600);
            tab.Controls.Add(card);

            Label cardTitle = CardTitle("连接配置", 24, 20);
            card.Controls.Add(cardTitle);

            Label help = new Label();
            help.Text = "没有命中模型路由时，Windsurf 请求会走这里的默认配置。";
            help.ForeColor = muted;
            help.Location = new Point(26, 54);
            help.Size = new Size(820, 22);
            card.Controls.Add(help);

            Label upstreamTitle = SectionLabel("默认上游", 26, 92);
            card.Controls.Add(upstreamTitle);

            Panel divider = new Panel();
            divider.BackColor = border;
            divider.Location = new Point(664, 92);
            divider.Size = new Size(1, 430);
            card.Controls.Add(divider);

            Label templateLabel = FieldLabel("服务商模板", 26, 126);
            card.Controls.Add(templateLabel);
            providerTemplateBox = new ComboBox();
            providerTemplateBox.DropDownStyle = ComboBoxStyle.DropDownList;
            providerTemplateBox.Font = new Font("Segoe UI", 10F);
            providerTemplateBox.Items.Add("自定义");
            providerTemplateBox.Items.Add("OpenAI 格式");
            providerTemplateBox.Items.Add("Anthropic 格式");
            providerTemplateBox.Location = new Point(26, 150);
            providerTemplateBox.Size = new Size(590, 32);
            providerTemplateBox.SelectedIndex = 1;
            providerTemplateBox.SelectedIndexChanged += delegate { ApplyProviderTemplate(); };
            card.Controls.Add(providerTemplateBox);

            baseUrlBox = TextInput(card, "接口地址", 26, 212, 590, "例如 https://api.openai.com/v1 或 https://relay.example.com/v1");
            modelBox = TextInput(card, "默认模型", 26, 292, 300, "例如 gpt-5.5");

            Label wireLabel = FieldLabel("接口类型", 356, 270);
            card.Controls.Add(wireLabel);
            wireApiBox = new ComboBox();
            wireApiBox.DropDownStyle = ComboBoxStyle.DropDownList;
            wireApiBox.Font = new Font("Segoe UI", 10.5F);
            wireApiBox.Items.Add(WireApiDisplay("responses"));
            wireApiBox.Items.Add(WireApiDisplay("chat"));
            wireApiBox.Items.Add(WireApiDisplay("anthropic"));
            wireApiBox.Location = new Point(356, 292);
            wireApiBox.Size = new Size(260, 32);
            wireApiBox.SelectedIndexChanged += delegate { UpdateThinkingVisibility(); };
            card.Controls.Add(wireApiBox);

            apiKeyBox = TextInput(card, "API 密钥", 26, 372, 590, "sk-...");
            apiKeyBox.UseSystemPasswordChar = true;
            showKeyBox = new CheckBox();
            showKeyBox.Text = "显示密钥";
            showKeyBox.ForeColor = muted;
            showKeyBox.BackColor = Color.White;
            showKeyBox.Location = new Point(528, 346);
            showKeyBox.Size = new Size(108, 24);
            showKeyBox.CheckedChanged += delegate { apiKeyBox.UseSystemPasswordChar = !showKeyBox.Checked; };
            card.Controls.Add(showKeyBox);

            windsurfPathBox = TextInput(card, "Windsurf 路径", 26, 452, 490, "请选择 Windsurf.exe");
            Button browse = SmallButton("浏览", 528, 450, 88, 32);
            browse.Click += delegate { BrowseWindsurf(); };
            card.Controls.Add(browse);

            thinkingModeLabel = FieldLabel("思考模式", 26, 506);
            card.Controls.Add(thinkingModeLabel);
            thinkingModeBox = new ComboBox();
            thinkingModeBox.DropDownStyle = ComboBoxStyle.DropDownList;
            thinkingModeBox.Font = new Font("Segoe UI", 10F);
            thinkingModeBox.Items.Add("默认（不指定）");
            thinkingModeBox.Items.Add("关闭");
            thinkingModeBox.Items.Add("自适应");
            thinkingModeBox.Items.Add("手动开启");
            thinkingModeBox.Location = new Point(26, 530);
            thinkingModeBox.Size = new Size(176, 32);
            thinkingModeBox.SelectedIndexChanged += delegate { UpdateThinkingVisibility(); };
            card.Controls.Add(thinkingModeBox);

            thinkingEffortLabel = FieldLabel("思考强度", 224, 506);
            card.Controls.Add(thinkingEffortLabel);
            thinkingEffortBox = new ComboBox();
            thinkingEffortBox.DropDownStyle = ComboBoxStyle.DropDownList;
            thinkingEffortBox.Font = new Font("Segoe UI", 10F);
            AddThinkingEffortItems(thinkingEffortBox, false, "responses");
            thinkingEffortBox.Location = new Point(224, 530);
            thinkingEffortBox.Size = new Size(176, 32);
            card.Controls.Add(thinkingEffortBox);

            thinkingBudgetLabel = FieldLabel("思考预算（0=自动）", 422, 506);
            card.Controls.Add(thinkingBudgetLabel);
            thinkingBudgetBox = new NumericUpDown();
            thinkingBudgetBox.Minimum = 0;
            thinkingBudgetBox.Maximum = 1000000;
            thinkingBudgetBox.ThousandsSeparator = true;
            thinkingBudgetBox.Font = new Font("Segoe UI", 10F);
            thinkingBudgetBox.Location = new Point(422, 530);
            thinkingBudgetBox.Size = new Size(194, 32);
            card.Controls.Add(thinkingBudgetBox);

            thinkingHelpLabel = new Label();
            thinkingHelpLabel.Text = "不确定时保持默认。";
            thinkingHelpLabel.ForeColor = muted;
            thinkingHelpLabel.Location = new Point(26, 566);
            thinkingHelpLabel.Size = new Size(590, 22);
            card.Controls.Add(thinkingHelpLabel);

            Label runtimeTitle = SectionLabel("运行选项", 704, 92);
            card.Controls.Add(runtimeTitle);

            Label portLabel = FieldLabel("本地端口", 704, 136);
            card.Controls.Add(portLabel);
            portBox = new NumericUpDown();
            portBox.Minimum = 1024;
            portBox.Maximum = 65535;
            portBox.Value = 3009;
            portBox.Font = new Font("Segoe UI", 10.5F);
            portBox.Location = new Point(704, 160);
            portBox.Size = new Size(120, 32);
            card.Controls.Add(portBox);

            launchWindsurfBox = new CheckBox();
            launchWindsurfBox.Text = "启动后打开 Windsurf";
            launchWindsurfBox.Checked = true;
            launchWindsurfBox.ForeColor = text;
            launchWindsurfBox.Font = new Font("Segoe UI", 10F);
            launchWindsurfBox.Location = new Point(704, 214);
            launchWindsurfBox.Size = new Size(180, 26);
            launchWindsurfBox.CheckedChanged += delegate { UpdateStartButtonText(); };
            card.Controls.Add(launchWindsurfBox);

            Button test = SmallButton("测试连接", 704, 260, 150, 34);
            test.Click += delegate { TestConnectionFromUi(); };
            card.Controls.Add(test);

            Button fetchModels = SmallButton("拉取模型列表", 704, 304, 150, 34);
            fetchModels.Click += delegate { FetchModelsFromUi(); };
            card.Controls.Add(fetchModels);

            Button save = AccentButton("保存配置", 704, 348, 150, 34);
            save.Click += delegate { SaveConfigFromUi(); };
            card.Controls.Add(save);

            Button openConfig = SmallButton("打开配置文件", 704, 396, 150, 34);
            openConfig.Click += delegate { SaveConfigFromUi(); OpenFile(configPath); };
            card.Controls.Add(openConfig);
        }

        private void BuildRoutesTab(TabPage tab)
        {
            tab.BackColor = bg;
            Panel card = Card(22, 24, 930, 500);
            tab.Controls.Add(card);

            Label cardTitle = CardTitle("模型路由", 24, 20);
            card.Controls.Add(cardTitle);

            Label help = new Label();
            help.Text = "每条路由可单独设置中转模型和思考参数。点击行内“编辑”按钮或双击任意路由进行详细配置。";
            help.ForeColor = muted;
            help.Location = new Point(26, 54);
            help.Size = new Size(860, 22);
            card.Controls.Add(help);

            routesGrid = new DataGridView();
            routesGrid.Location = new Point(26, 90);
            routesGrid.Size = new Size(870, 320);
            routesGrid.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            routesGrid.AllowUserToAddRows = false;
            routesGrid.AllowUserToDeleteRows = true;
            routesGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            routesGrid.Font = new Font("Segoe UI", 10F);
            routesGrid.RowTemplate.Height = 32;
            routesGrid.ColumnHeadersHeight = 34;
            routesGrid.BackgroundColor = Color.White;
            routesGrid.BorderStyle = BorderStyle.FixedSingle;
            routesGrid.RowHeadersVisible = false;
            routesGrid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            routesGrid.MultiSelect = false;
            routesGrid.EnableHeadersVisualStyles = false;
            routesGrid.EditingControlShowing += RoutesGridEditingControlShowing;
            routesGrid.CellValidating += RoutesGridCellValidating;
            routesGrid.CellParsing += RoutesGridCellParsing;
            routesGrid.CurrentCellDirtyStateChanged += delegate
            {
                if (routesGrid.IsCurrentCellDirty) routesGrid.CommitEdit(DataGridViewDataErrorContexts.Commit);
            };
            routesGrid.CellDoubleClick += delegate { EditSelectedRoute(); };
            routesGrid.CellContentClick += RoutesGridCellContentClick;
            routesGrid.DataError += delegate(object sender, DataGridViewDataErrorEventArgs e) { e.ThrowException = false; };
            routesGrid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(238, 242, 247);
            routesGrid.ColumnHeadersDefaultCellStyle.ForeColor = text;
            routesGrid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI Semibold", 9.5F, FontStyle.Bold);
            routesGrid.DefaultCellStyle.Font = new Font("Segoe UI", 10F);
            routesGrid.DefaultCellStyle.Padding = new Padding(3, 2, 3, 2);
            routesGrid.GridColor = border;
            routesGrid.Columns.Add(ModelIdColumn("windsurf", "Windsurf 模型 ID", 230));
            routesGrid.Columns.Add(TextColumn("model", "中转模型", 170));
            routesGrid.Columns.Add(TextColumn("wireApi", "接口类型", 120));
            routesGrid.Columns.Add(TextColumn("thinkingSummary", "思考设置", 150));
            routesGrid.Columns.Add(TextColumn("baseUrl", "接口地址", 200));
            routesGrid.Columns.Add(TextColumn("apiKey", "API 密钥", 120));
            DataGridViewButtonColumn editAction = new DataGridViewButtonColumn();
            editAction.Name = "editAction";
            editAction.HeaderText = "操作";
            editAction.Text = "编辑";
            editAction.UseColumnTextForButtonValue = true;
            editAction.Width = 72;
            editAction.AutoSizeMode = DataGridViewAutoSizeColumnMode.None;
            editAction.FlatStyle = FlatStyle.Standard;
            routesGrid.Columns.Add(editAction);
            routesGrid.Columns.Add(TextColumn("thinkingMode", "thinkingMode", 10));
            routesGrid.Columns.Add(TextColumn("thinkingEffort", "thinkingEffort", 10));
            routesGrid.Columns.Add(TextColumn("thinkingBudgetTokens", "thinkingBudgetTokens", 10));
            routesGrid.Columns["apiKey"].Visible = false;
            routesGrid.Columns["thinkingMode"].Visible = false;
            routesGrid.Columns["thinkingEffort"].Visible = false;
            routesGrid.Columns["thinkingBudgetTokens"].Visible = false;
            card.Controls.Add(routesGrid);

            Button add = AccentButton("新增路由", 26, 436, 104, 34);
            add.Click += delegate
            {
                RouteEditorForm editor = new RouteEditorForm(
                    "",
                    baseUrlBox.Text,
                    "",
                    modelBox.Text,
                    NormalizeWireApi(Convert.ToString(wireApiBox.SelectedItem)),
                    "",
                    "",
                    -1,
                    WindsurfModelIdPresets);
                if (editor.ShowDialog(this) == DialogResult.OK)
                {
                    AddRouteRow(
                        editor.WindsurfModel,
                        editor.BaseUrl,
                        editor.ApiKey,
                        editor.Model,
                        editor.WireApi,
                        editor.ThinkingMode,
                        editor.ThinkingEffort,
                        editor.ThinkingBudgetTokens);
                }
            };
            card.Controls.Add(add);

            Button edit = AccentButton("编辑路由", 140, 436, 104, 34);
            edit.Click += delegate { EditSelectedRoute(); };
            card.Controls.Add(edit);

            Button remove = SmallButton("删除选中", 254, 436, 104, 34);
            remove.Click += delegate { DeleteSelectedRoute(); };
            card.Controls.Add(remove);

            Button discover = SmallButton("从日志发现模型", 368, 436, 138, 34);
            discover.Click += delegate { DiscoverModelsFromLog(); };
            card.Controls.Add(discover);

            Button save = SmallButton("保存路由", 516, 436, 104, 34);
            save.Click += delegate { SaveConfigFromUi(); };
            card.Controls.Add(save);
        }

        private void BuildLogsTab(TabPage tab)
        {
            tab.BackColor = bg;
            Panel card = Card(22, 24, 930, 520);
            tab.Controls.Add(card);

            Label cardTitle = CardTitle("运行日志", 24, 20);
            card.Controls.Add(cardTitle);

            logBox = new TextBox();
            logBox.Location = new Point(26, 60);
            logBox.Size = new Size(870, 382);
            logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            logBox.Multiline = true;
            logBox.ScrollBars = ScrollBars.Vertical;
            logBox.ReadOnly = true;
            logBox.BackColor = Color.FromArgb(17, 24, 39);
            logBox.ForeColor = Color.FromArgb(224, 231, 255);
            logBox.BorderStyle = BorderStyle.None;
            logBox.Font = new Font("Consolas", 10.5F);
            card.Controls.Add(logBox);

            Button openStdout = SmallButton("打开运行日志", 26, 462, 118, 34);
            openStdout.Click += delegate { OpenFile(appLog); };
            card.Controls.Add(openStdout);

            Button openStderr = SmallButton("打开错误日志", 158, 462, 118, 34);
            openStderr.Click += delegate { OpenFile(stderrLog); };
            card.Controls.Add(openStderr);

            Button clear = SmallButton("清空当前显示", 290, 462, 118, 34);
            clear.Click += delegate { logBox.Clear(); };
            card.Controls.Add(clear);

            onlyErrorLogsBox = new CheckBox();
            onlyErrorLogsBox.Text = "只看错误";
            onlyErrorLogsBox.ForeColor = text;
            onlyErrorLogsBox.BackColor = Color.White;
            onlyErrorLogsBox.Location = new Point(426, 468);
            onlyErrorLogsBox.Size = new Size(94, 24);
            card.Controls.Add(onlyErrorLogsBox);

            Button copyErrors = SmallButton("复制错误", 532, 462, 98, 34);
            copyErrors.Click += delegate { CopyErrorLogs(); };
            card.Controls.Add(copyErrors);

            Button clearFiles = SmallButton("清空日志文件", 642, 462, 118, 34);
            clearFiles.Click += delegate { ClearLogFiles(); };
            card.Controls.Add(clearFiles);
        }

        private Panel SidebarCard(int x, int y, int w, int h)
        {
            Panel p = new Panel();
            p.Location = new Point(x, y);
            p.Size = new Size(w, h);
            p.BackColor = Color.FromArgb(31, 42, 59);
            return p;
        }

        private Panel Card(int x, int y, int w, int h)
        {
            Panel p = new Panel();
            p.Location = new Point(x, y);
            p.Size = new Size(w, h);
            p.BackColor = panelBg;
            p.BorderStyle = BorderStyle.FixedSingle;
            return p;
        }

        private Label CardTitle(string s, int x, int y)
        {
            Label l = new Label();
            l.Text = s;
            l.Font = new Font("Segoe UI Semibold", 13F, FontStyle.Bold);
            l.ForeColor = text;
            l.Location = new Point(x, y);
            l.Size = new Size(240, 28);
            return l;
        }

        private Label SectionLabel(string s, int x, int y)
        {
            Label l = new Label();
            l.Text = s;
            l.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
            l.ForeColor = text;
            l.Location = new Point(x, y);
            l.Size = new Size(180, 24);
            return l;
        }

        private Label FieldLabel(string s, int x, int y)
        {
            Label l = new Label();
            l.Text = s;
            l.ForeColor = muted;
            l.Font = new Font("Segoe UI", 9.5F);
            l.Location = new Point(x, y);
            l.Size = new Size(160, 20);
            return l;
        }

        private TextBox TextInput(Control parent, string label, int x, int y, int w, string placeholder)
        {
            Label l = FieldLabel(label, x, y - 22);
            parent.Controls.Add(l);

            TextBox box = new TextBox();
            box.Location = new Point(x, y);
            box.Size = new Size(w, 32);
            box.BorderStyle = BorderStyle.FixedSingle;
            box.ForeColor = text;
            box.BackColor = Color.White;
            box.Font = new Font("Segoe UI", 10.5F);
            box.Tag = placeholder;
            parent.Controls.Add(box);
            return box;
        }

        private Button PrimaryButton(string s, int x, int y, int w, int h)
        {
            Button b = new Button();
            b.Text = s;
            b.Location = new Point(x, y);
            b.Size = new Size(w, h);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.BackColor = accent;
            b.ForeColor = Color.White;
            b.Font = new Font("Segoe UI Semibold", 10.5F, FontStyle.Bold);
            return b;
        }

        private Button AccentButton(string s, int x, int y, int w, int h)
        {
            Button b = SmallButton(s, x, y, w, h);
            b.BackColor = accent;
            b.ForeColor = Color.White;
            b.FlatAppearance.BorderColor = accent;
            b.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
            return b;
        }

        private Button SmallButton(string s, int x, int y, int w, int h)
        {
            Button b = new Button();
            b.Text = s;
            b.Location = new Point(x, y);
            b.Size = new Size(w, h);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = border;
            b.BackColor = Color.White;
            b.ForeColor = text;
            b.Font = new Font("Segoe UI", 10F);
            return b;
        }

        private Button SecondarySidebarButton(string s, int x, int y, int w, int h)
        {
            Button b = new Button();
            b.Text = s;
            b.Location = new Point(x, y);
            b.Size = new Size(w, h);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Color.FromArgb(73, 88, 110);
            b.BackColor = Color.FromArgb(31, 42, 59);
            b.ForeColor = Color.FromArgb(224, 231, 255);
            b.Font = new Font("Segoe UI", 10F);
            return b;
        }

        private Button SidebarMiniButton(string s, int x, int y, int w, int h)
        {
            Button b = new Button();
            b.Text = s;
            b.Location = new Point(x, y);
            b.Size = new Size(w, h);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Color.FromArgb(88, 105, 130);
            b.BackColor = Color.FromArgb(39, 52, 72);
            b.ForeColor = Color.FromArgb(224, 231, 255);
            b.Font = new Font("Segoe UI", 8.5F);
            return b;
        }

        private DataGridViewTextBoxColumn TextColumn(string name, string header, int width)
        {
            DataGridViewTextBoxColumn c = new DataGridViewTextBoxColumn();
            c.Name = name;
            c.HeaderText = header;
            c.Width = width;
            return c;
        }

        private DataGridViewComboBoxColumn ModelIdColumn(string name, string header, int width)
        {
            DataGridViewComboBoxColumn c = new DataGridViewComboBoxColumn();
            c.Name = name;
            c.HeaderText = header;
            c.Width = width;
            c.DisplayStyle = DataGridViewComboBoxDisplayStyle.DropDownButton;
            c.FlatStyle = FlatStyle.Flat;
            for (int i = 0; i < WindsurfModelIdPresets.Length; i++)
            {
                c.Items.Add(WindsurfModelIdPresets[i]);
            }
            return c;
        }

        private void RoutesGridEditingControlShowing(object sender, DataGridViewEditingControlShowingEventArgs e)
        {
            if (routesGrid.CurrentCell == null) return;
            if (routesGrid.Columns[routesGrid.CurrentCell.ColumnIndex].Name != "windsurf") return;
            ComboBox combo = e.Control as ComboBox;
            if (combo == null) return;
            combo.DropDownStyle = ComboBoxStyle.DropDown;
            combo.AutoCompleteMode = AutoCompleteMode.SuggestAppend;
            combo.AutoCompleteSource = AutoCompleteSource.ListItems;
        }

        private void RoutesGridCellValidating(object sender, DataGridViewCellValidatingEventArgs e)
        {
            if (e.RowIndex < 0 || e.ColumnIndex < 0) return;
            if (routesGrid.Columns[e.ColumnIndex].Name != "windsurf") return;
            AddWindsurfModelChoice(Convert.ToString(e.FormattedValue).Trim());
        }

        private void RoutesGridCellParsing(object sender, DataGridViewCellParsingEventArgs e)
        {
            if (e.RowIndex < 0 || e.ColumnIndex < 0) return;
            if (routesGrid.Columns[e.ColumnIndex].Name != "windsurf") return;
            string value = Convert.ToString(e.Value).Trim();
            AddWindsurfModelChoice(value);
            e.Value = value;
            e.ParsingApplied = true;
        }

        private void RoutesGridCellContentClick(object sender, DataGridViewCellEventArgs e)
        {
            if (e.RowIndex < 0 || e.ColumnIndex < 0) return;
            if (routesGrid.Columns[e.ColumnIndex].Name != "editAction") return;
            if (routesGrid.Rows[e.RowIndex].IsNewRow) return;
            routesGrid.CurrentCell = routesGrid.Rows[e.RowIndex].Cells["windsurf"];
            routesGrid.Rows[e.RowIndex].Selected = true;
            EditSelectedRoute();
        }

        private void AddWindsurfModelChoice(string modelId)
        {
            if (modelId == null || modelId.Trim().Length == 0) return;
            string id = modelId.Trim();
            DataGridViewComboBoxColumn column = routesGrid.Columns["windsurf"] as DataGridViewComboBoxColumn;
            if (column == null) return;
            for (int i = 0; i < column.Items.Count; i++)
            {
                if (String.Equals(Convert.ToString(column.Items[i]), id, StringComparison.OrdinalIgnoreCase)) return;
            }
            column.Items.Add(id);
        }

        private string[] GetKnownWindsurfModelIds()
        {
            List<string> ids = new List<string>();
            for (int i = 0; i < WindsurfModelIdPresets.Length; i++)
            {
                if (!ids.Contains(WindsurfModelIdPresets[i])) ids.Add(WindsurfModelIdPresets[i]);
            }
            if (routesGrid != null)
            {
                foreach (DataGridViewRow row in routesGrid.Rows)
                {
                    if (row.IsNewRow) continue;
                    string id = Cell(row, "windsurf").Trim();
                    if (id.Length > 0 && !ids.Contains(id)) ids.Add(id);
                }
            }
            return ids.ToArray();
        }

        private void BuildTrayIcon()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem showItem = new ToolStripMenuItem("显示窗口");
            showItem.Click += delegate { RestoreFromTray(); };
            menu.Items.Add(showItem);
            ToolStripMenuItem stopItem = new ToolStripMenuItem("停止代理");
            stopItem.Click += async delegate { await StopProxyAsync(); };
            menu.Items.Add(stopItem);
            ToolStripMenuItem exitItem = new ToolStripMenuItem("退出应用");
            exitItem.Click += delegate { ExitApplication(); };
            menu.Items.Add(exitItem);

            trayIcon = new NotifyIcon();
            trayIcon.Text = "Windsurf Cascade 代理";
            trayIcon.Icon = Icon ?? SystemIcons.Application;
            trayIcon.ContextMenuStrip = menu;
            trayIcon.Visible = true;
            trayIcon.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) RestoreFromTray();
            };
        }

        private void MainFormClosing(object sender, FormClosingEventArgs e)
        {
            if (forceExit)
            {
                if (trayIcon != null) trayIcon.Visible = false;
                return;
            }

            DialogResult result = MessageBox.Show(
                "是否退出 Windsurf Cascade 代理应用？\r\n\r\n选择“是”：退出应用，并停止本程序启动的代理。\r\n选择“否”：最小化到托盘，代理继续运行。\r\n选择“取消”：返回应用。",
                "是否退出应用",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button1);

            if (result == DialogResult.Cancel)
            {
                e.Cancel = true;
                return;
            }
            if (result == DialogResult.No)
            {
                e.Cancel = true;
                MinimizeToTray();
                return;
            }

            StopTrackedProxyProcess();
            forceExit = true;
            if (trayIcon != null) trayIcon.Visible = false;
        }

        private void ExitApplication()
        {
            StopTrackedProxyProcess();
            forceExit = true;
            if (trayIcon != null) trayIcon.Visible = false;
            Close();
        }

        private void MainFormResize(object sender, EventArgs e)
        {
            if (WindowState == FormWindowState.Minimized)
            {
                MinimizeToTray();
            }
        }

        private void MinimizeToTray()
        {
            if (trayIcon != null)
            {
                trayIcon.Visible = true;
                trayIcon.ShowBalloonTip(1200, "Windsurf Cascade 代理", "程序已最小化到托盘，代理会继续运行。", ToolTipIcon.Info);
            }
            Hide();
        }

        private void RestoreFromTray()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void EnsureRuntimeFiles()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            for (int i = 0; i < RuntimeResources.Length; i++)
            {
                RuntimeResource item = RuntimeResources[i];
                string target = Path.Combine(runtimeDir, item.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                Stream input = assembly.GetManifestResourceStream(item.Name);
                if (input == null)
                {
                    throw new InvalidOperationException("Missing embedded resource: " + item.Name);
                }
                using (input)
                using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.Read))
                {
                    input.CopyTo(output);
                }
            }
        }

        private void CleanupLegacyRuntimeNames()
        {
            string legacyPath = Path.Combine(runtimeDir, "z" + "wh-v2-extracted");
            if (!Directory.Exists(legacyPath)) return;
            try
            {
                Directory.Delete(legacyPath, true);
                AppendRawAppLog(DateTime.Now.ToString("HH:mm:ss") + "  已清理旧协议运行目录。");
            }
            catch (Exception ex)
            {
                AppendRawAppLog(DateTime.Now.ToString("HH:mm:ss") + "  旧协议运行目录暂时无法清理：" + ex.Message);
            }
        }

        private ProxyConfig LoadConfig()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string bootstrap = Path.Combine(exeDir, "windsurf-proxy-config.json");
            string parentBootstrap = Path.Combine(Directory.GetParent(exeDir.TrimEnd(Path.DirectorySeparatorChar)).FullName, "windsurf-proxy-config.json");
            string source = File.Exists(configPath) ? configPath :
                (File.Exists(bootstrap) ? bootstrap :
                (File.Exists(parentBootstrap) ? parentBootstrap : ""));
            if (source.Length > 0)
            {
                try
                {
                    string raw = File.ReadAllText(source, Encoding.UTF8);
                    ProxyConfig loaded = json.Deserialize<ProxyConfig>(raw);
                    if (loaded != null)
                    {
                        if (loaded.modelRoutes == null) loaded.modelRoutes = new Dictionary<string, ModelRoute>();
                        return loaded;
                    }
                }
                catch (Exception ex)
                {
                    AppendRawAppLog("Could not read config: " + ex.Message);
                }
            }
            return new ProxyConfig();
        }

        private void ApplyProviderTemplate()
        {
            if (providerTemplateBox == null || providerTemplateBox.SelectedItem == null) return;
            string selected = Convert.ToString(providerTemplateBox.SelectedItem);
            if (selected == "自定义") return;

            if (selected == "OpenAI 格式")
            {
                baseUrlBox.Text = "https://api.openai.com/v1";
                modelBox.Text = "gpt-5.5";
                wireApiBox.SelectedItem = WireApiDisplay("responses");
            }
            else if (selected == "Anthropic 格式")
            {
                baseUrlBox.Text = "https://api.anthropic.com/v1";
                modelBox.Text = "claude-sonnet-4-5";
                wireApiBox.SelectedItem = WireApiDisplay("anthropic");
                thinkingModeBox.SelectedItem = "自适应";
                thinkingEffortBox.SelectedItem = "高";
                thinkingBudgetBox.Value = 0;
            }
            UpdateThinkingVisibility();
        }

        private void UpdateThinkingVisibility()
        {
            string wire = NormalizeWireApi(Convert.ToString(wireApiBox == null ? "" : wireApiBox.SelectedItem));
            bool anthropic = wire == "anthropic";

            string selectedEffort = NormalizeThinkingEffort(Convert.ToString(thinkingEffortBox == null ? "" : thinkingEffortBox.SelectedItem));
            AddThinkingEffortItems(thinkingEffortBox, false, wire);
            string effortDisplay = ThinkingEffortDisplay(selectedEffort, false);
            thinkingEffortBox.SelectedItem = thinkingEffortBox.Items.Contains(effortDisplay) ? effortDisplay : "默认（不指定）";

            thinkingModeLabel.Visible = anthropic;
            thinkingModeBox.Visible = anthropic;
            thinkingBudgetLabel.Visible = anthropic;
            thinkingBudgetBox.Visible = anthropic;
            thinkingBudgetBox.Enabled = anthropic && NormalizeThinkingMode(Convert.ToString(thinkingModeBox.SelectedItem)) == "enabled";

            if (anthropic)
            {
                thinkingEffortLabel.Text = "思考强度";
                thinkingEffortLabel.Location = new Point(224, 506);
                thinkingEffortBox.Location = new Point(224, 530);
                thinkingEffortBox.Size = new Size(176, 32);
                thinkingHelpLabel.Text = "Anthropic：思考模式控制 thinking；强度使用 output_config.effort；预算仅用于“手动开启”。";
            }
            else
            {
                thinkingEffortLabel.Text = wire == "responses" ? "推理强度（reasoning.effort）" : "推理强度（reasoning_effort）";
                thinkingEffortLabel.Location = new Point(26, 506);
                thinkingEffortBox.Location = new Point(26, 530);
                thinkingEffortBox.Size = new Size(374, 32);
                thinkingHelpLabel.Text = wire == "responses"
                    ? "OpenAI Responses：仅发送 reasoning.effort；上游不支持时会自动去掉参数重试。"
                    : "OpenAI Chat：仅发送 reasoning_effort；上游不支持时会自动去掉参数重试。";
            }
        }

        private void LoadConfigIntoUi()
        {
            baseUrlBox.Text = config.openaiBaseUrl ?? "";
            apiKeyBox.Text = config.openaiApiKey ?? "";
            modelBox.Text = config.openaiModel ?? "";
            wireApiBox.SelectedItem = WireApiDisplay(NormalizeWireApi(config.openaiWireApi));
            if (wireApiBox.SelectedIndex < 0) wireApiBox.SelectedIndex = 0;
            thinkingModeBox.SelectedItem = ThinkingModeDisplay(NormalizeThinkingMode(config.thinkingMode), false);
            if (thinkingModeBox.SelectedIndex < 0) thinkingModeBox.SelectedIndex = 0;
            thinkingEffortBox.SelectedItem = ThinkingEffortDisplay(NormalizeThinkingEffort(config.thinkingEffort), false);
            if (thinkingEffortBox.SelectedIndex < 0) thinkingEffortBox.SelectedIndex = 0;
            int thinkingBudget = config.thinkingBudgetTokens < 0 ? 0 : config.thinkingBudgetTokens;
            if (thinkingBudget > thinkingBudgetBox.Maximum) thinkingBudget = (int)thinkingBudgetBox.Maximum;
            thinkingBudgetBox.Value = thinkingBudget;
            windsurfPathBox.Text = config.windsurfPath ?? "";
            int port = config.port <= 0 ? 3009 : config.port;
            if (port < portBox.Minimum) port = (int)portBox.Minimum;
            if (port > portBox.Maximum) port = (int)portBox.Maximum;
            portBox.Value = port;
            launchWindsurfBox.Checked = config.launchWindsurfOnStart;
            UpdateThinkingVisibility();
            UpdateStartButtonText();

            routesGrid.Rows.Clear();
            if (config.modelRoutes != null)
            {
                foreach (KeyValuePair<string, ModelRoute> pair in config.modelRoutes)
                {
                    ModelRoute route = pair.Value ?? new ModelRoute();
                    AddRouteRow(
                        pair.Key,
                        route.baseUrl,
                        route.apiKey,
                        route.model,
                        route.wireApi,
                        route.thinkingMode,
                        route.thinkingEffort,
                        route.thinkingBudgetTokens);
                }
            }
            UpdateRouteCount();
        }

        private void SaveConfigFromUi()
        {
            if (routesGrid != null)
            {
                if (routesGrid.IsCurrentCellDirty) routesGrid.CommitEdit(DataGridViewDataErrorContexts.Commit);
                routesGrid.EndEdit();
            }
            config.openaiBaseUrl = baseUrlBox.Text.Trim();
            config.openaiApiKey = apiKeyBox.Text.Trim();
            config.openaiModel = modelBox.Text.Trim();
            config.openaiWireApi = NormalizeWireApi(Convert.ToString(wireApiBox.SelectedItem));
            config.thinkingEffort = NormalizeThinkingEffort(Convert.ToString(thinkingEffortBox.SelectedItem));
            if (config.openaiWireApi == "anthropic")
            {
                config.thinkingMode = NormalizeThinkingMode(Convert.ToString(thinkingModeBox.SelectedItem));
                config.thinkingBudgetTokens = (int)thinkingBudgetBox.Value;
            }
            else
            {
                config.thinkingMode = "default";
                config.thinkingBudgetTokens = 0;
            }
            config.windsurfPath = windsurfPathBox.Text.Trim();
            int oldPort = config.port;
            config.port = (int)portBox.Value;
            config.launchWindsurfOnStart = launchWindsurfBox.Checked;
            config.upstreamProvider = "openai-compatible";
            config.modelRoutes = ReadRoutesFromGrid();
            SaveConfigToDisk();
            if (oldPort > 0 && oldPort != config.port)
            {
                MessageBox.Show("本地端口已修改。\r\n\r\n需要重新安装补丁，并重启或重新打开 Windsurf。", "端口已修改", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            UpdateRouteCount();
            AppendLog("已保存配置：" + configPath);
        }

        private void SaveConfigToDisk()
        {
            Directory.CreateDirectory(runtimeDir);
            string data = json.Serialize(config);
            File.WriteAllText(configPath, PrettyJson(data), new UTF8Encoding(false));
        }

        private Dictionary<string, ModelRoute> ReadRoutesFromGrid()
        {
            Dictionary<string, ModelRoute> routes = new Dictionary<string, ModelRoute>();
            foreach (DataGridViewRow row in routesGrid.Rows)
            {
                if (row.IsNewRow) continue;
                string key = Cell(row, "windsurf").Trim();
                if (key.Length == 0) continue;
                ModelRoute route = new ModelRoute();
                route.baseUrl = Cell(row, "baseUrl").Trim();
                route.apiKey = Cell(row, "apiKey").Trim();
                route.model = Cell(row, "model").Trim();
                route.wireApi = NormalizeWireApi(Cell(row, "wireApi"));
                route.thinkingMode = NormalizeRouteThinkingMode(Cell(row, "thinkingMode"));
                route.thinkingEffort = NormalizeRouteThinkingEffort(Cell(row, "thinkingEffort"));
                route.thinkingBudgetTokens = ParseRouteThinkingBudget(Cell(row, "thinkingBudgetTokens"));
                routes[key] = route;
            }
            return routes;
        }

        private string Cell(DataGridViewRow row, string name)
        {
            object value = row.Cells[name].Value;
            return value == null ? "" : Convert.ToString(value);
        }

        private void AddRouteRow(
            string windsurfModel,
            string baseUrl,
            string apiKey,
            string model,
            string wireApi,
            string thinkingMode = "",
            string thinkingEffort = "",
            int thinkingBudgetTokens = -1)
        {
            AddWindsurfModelChoice(windsurfModel);
            int idx = routesGrid.Rows.Add();
            DataGridViewRow row = routesGrid.Rows[idx];
            row.Cells["windsurf"].Value = windsurfModel ?? "";
            row.Cells["baseUrl"].Value = baseUrl ?? "";
            row.Cells["apiKey"].Value = apiKey ?? "";
            row.Cells["model"].Value = model ?? "";
            row.Cells["wireApi"].Value = NormalizeWireApi(wireApi);
            row.Cells["thinkingMode"].Value = ThinkingModeDisplay(NormalizeRouteThinkingMode(thinkingMode), true);
            row.Cells["thinkingEffort"].Value = ThinkingEffortDisplay(NormalizeRouteThinkingEffort(thinkingEffort), true);
            row.Cells["thinkingBudgetTokens"].Value = thinkingBudgetTokens < 0 ? "" : Convert.ToString(thinkingBudgetTokens);
            UpdateRouteSummary(row);
            UpdateRouteCount();
        }

        private void UpdateRouteSummary(DataGridViewRow row)
        {
            if (row == null || row.IsNewRow) return;
            string wire = NormalizeWireApi(Cell(row, "wireApi"));
            row.Cells["wireApi"].Value = WireApiDisplay(wire);
            string mode = Cell(row, "thinkingMode");
            string effort = Cell(row, "thinkingEffort");
            string budget = Cell(row, "thinkingBudgetTokens").Trim();
            string summary;
            if (wire == "anthropic")
            {
                summary = ThinkingModeDisplay(NormalizeRouteThinkingMode(mode), true) + " / " + ThinkingEffortDisplay(NormalizeRouteThinkingEffort(effort), true);
                if (budget.Length > 0) summary += " / " + budget;
            }
            else
            {
                summary = "推理强度：" + ThinkingEffortDisplay(NormalizeRouteThinkingEffort(effort), true);
            }
            row.Cells["thinkingSummary"].Value = summary;
        }

        private void EditSelectedRoute()
        {
            if (routesGrid.SelectedRows.Count == 0)
            {
                MessageBox.Show("请先选择一条模型路由。", "编辑路由", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            DataGridViewRow row = routesGrid.SelectedRows[0];
            if (row.IsNewRow) return;
            RouteEditorForm editor = new RouteEditorForm(
                Cell(row, "windsurf"),
                Cell(row, "baseUrl"),
                Cell(row, "apiKey"),
                Cell(row, "model"),
                NormalizeWireApi(Cell(row, "wireApi")),
                NormalizeRouteThinkingMode(Cell(row, "thinkingMode")),
                NormalizeRouteThinkingEffort(Cell(row, "thinkingEffort")),
                ParseRouteThinkingBudget(Cell(row, "thinkingBudgetTokens")),
                GetKnownWindsurfModelIds());
            if (editor.ShowDialog(this) != DialogResult.OK) return;
            AddWindsurfModelChoice(editor.WindsurfModel);
            row.Cells["windsurf"].Value = editor.WindsurfModel;
            row.Cells["baseUrl"].Value = editor.BaseUrl;
            row.Cells["apiKey"].Value = editor.ApiKey;
            row.Cells["model"].Value = editor.Model;
            row.Cells["wireApi"].Value = WireApiDisplay(editor.WireApi);
            row.Cells["thinkingMode"].Value = ThinkingModeDisplay(editor.ThinkingMode, true);
            row.Cells["thinkingEffort"].Value = ThinkingEffortDisplay(editor.ThinkingEffort, true);
            row.Cells["thinkingBudgetTokens"].Value = editor.ThinkingBudgetTokens < 0 ? "" : Convert.ToString(editor.ThinkingBudgetTokens);
            UpdateRouteSummary(row);
            UpdateRouteCount();
        }

        private void DeleteSelectedRoute()
        {
            if (routesGrid.SelectedRows.Count == 0) return;
            foreach (DataGridViewRow row in routesGrid.SelectedRows)
            {
                if (!row.IsNewRow) routesGrid.Rows.Remove(row);
            }
            UpdateRouteCount();
        }

        private void DiscoverModelsFromLog()
        {
            HashSet<string> existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (DataGridViewRow row in routesGrid.Rows)
            {
                if (!row.IsNewRow)
                {
                    string id = Cell(row, "windsurf").Trim();
                    if (id.Length > 0) existing.Add(id);
                }
            }

            int added = 0;
            foreach (string path in new string[] { stdoutLog, Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "windsurf-proxy.stdout.log") })
            {
                if (!File.Exists(path)) continue;
                string[] lines;
                try
                {
                    lines = ReadLogLinesShared(path);
                }
                catch (Exception ex)
                {
                    AppendLog("读取日志失败：" + Path.GetFileName(path) + "：" + ex.Message);
                    continue;
                }
                for (int i = 0; i < lines.Length; i++)
                {
                    string line = lines[i];
                    int start = line.IndexOf("GetChatMessage ");
                    int arrow = line.IndexOf(" -> ", StringComparison.Ordinal);
                    if (start < 0 || arrow < 0 || arrow <= start) continue;
                    string id = line.Substring(start + "GetChatMessage ".Length, arrow - (start + "GetChatMessage ".Length)).Trim();
                    if (id.Length == 0 || id == "(none)") continue;
                    AddWindsurfModelChoice(id);
                    if (existing.Contains(id)) continue;
                    AddRouteRow(id, baseUrlBox.Text.Trim(), "", modelBox.Text.Trim(), Convert.ToString(wireApiBox.SelectedItem));
                    existing.Add(id);
                    added++;
                }
            }
            AppendLog("从日志发现模型路由：" + added);
        }

        private string[] ReadLogLinesShared(string path)
        {
            List<string> lines = new List<string>();
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    lines.Add(line);
                }
            }
            return lines.ToArray();
        }

        private async Task StartFlowAsync()
        {
            if (proxyActionInProgress) return;
            try
            {
                proxyActionInProgress = true;
                startButton.Enabled = false;
                stopButton.Enabled = false;
                UseWaitCursor = true;
                SaveConfigFromUi();
                ValidateConfig();
                EnsureRuntimeFiles();
                SetStatus(false, "正在启动", "127.0.0.1:" + config.port);

                if (IsTrackedProxyRunning())
                {
                    AppendLog("正在停止本程序已启动的旧代理进程。");
                    await Task.Run(delegate { StopTrackedProxyProcess(); });
                    await Task.Delay(500);
                }

                bool portListening = await Task.Run(delegate { return IsPortListening(config.port); });
                if (portListening)
                {
                    if (!ConfirmStopPortProcess(config.port)) throw new InvalidOperationException("端口 " + config.port + " 正在被占用，代理未启动。");
                    AppendLog("端口 " + config.port + " 已有进程监听，正在按确认停止占用进程。");
                    int stopped = await Task.Run(delegate { return StopProcessesOnPort(config.port); });
                    AppendLog("已停止端口 " + config.port + " 上的进程数：" + stopped);
                    await Task.Delay(800);
                    CleanupLegacyRuntimeNames();
                }

                await Task.Run(delegate { ApplyPatch(); });
                await RefreshPatchStatusAsync(false);
                StartProxy();

                bool healthy = await Task.Run(delegate { return WaitForHealth(config.port, 7000); });
                if (!healthy)
                {
                    string err = ReadTail(stderrLog, 3000);
                    if (err.Length == 0) err = "No stderr was written.";
                    throw new InvalidOperationException("代理没有成功启动。\r\n\r\n" + err);
                }

                await RefreshHealthAsync(true);
                if (launchWindsurfBox.Checked) await LaunchWindsurfAsync();
            }
            catch (Exception ex)
            {
                SetStatus(false, "启动失败", ex.Message);
                AppendLog("错误：" + ex.Message);
                MessageBox.Show(ex.Message, "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                UseWaitCursor = false;
                proxyActionInProgress = false;
                startButton.Enabled = true;
                stopButton.Enabled = true;
                UpdateStartButtonText();
            }
        }

        private void ValidateConfig()
        {
            if (config.openaiBaseUrl == null || config.openaiBaseUrl.Trim().Length == 0)
                throw new InvalidOperationException("接口地址不能为空。");
            if (config.openaiApiKey == null || config.openaiApiKey.Trim().Length == 0)
                throw new InvalidOperationException("API 密钥不能为空。");
            if (config.openaiModel == null || config.openaiModel.Trim().Length == 0)
                throw new InvalidOperationException("默认模型不能为空。");
            if (config.windsurfPath == null || !File.Exists(config.windsurfPath))
                throw new InvalidOperationException("Windsurf.exe was not found: " + config.windsurfPath);
            string node = FindNode();
            if (node.Length == 0)
                throw new InvalidOperationException("没有找到 Node.js。请安装 Node.js，或把 node.exe 加入 PATH。");
        }

        private void ApplyPatchFromUi()
        {
            try
            {
                SaveConfigFromUi();
                ValidateConfig();
                ApplyPatch();
                RefreshPatchStatus(true);
                MessageBox.Show("原生补丁已安装。", "补丁", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                AppendLog("补丁安装失败：" + ex.Message);
                MessageBox.Show(ex.Message, "补丁安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void RestorePatchFromUi()
        {
            try
            {
                SaveConfigFromUi();
                ValidatePatchPrerequisites();
                DialogResult result = MessageBox.Show(
                    "恢复补丁会把 Windsurf 的 Cascade 请求地址还原为官方默认值。\r\n\r\n恢复后需要重启 Windsurf。是否继续？",
                    "恢复补丁",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (result != DialogResult.Yes) return;

                RestorePatch();
                RefreshPatchStatus(true);
                MessageBox.Show("补丁已恢复。请重启 Windsurf。", "恢复补丁", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                AppendLog("恢复补丁失败：" + ex.Message);
                MessageBox.Show(ex.Message, "恢复补丁失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ApplyPatch()
        {
            string node = FindNode();
            string patch = Path.Combine(runtimeDir, "windsurf-native-patch.mjs");
            string apiUrl = "http://localhost:" + config.port;
            string args = Quote(patch) + " apply --windsurfPath " + Quote(config.windsurfPath) + " --apiUrl " + Quote(apiUrl);
            AppendLog("正在安装 Windsurf 原生补丁...");
            string output = RunCapture(node, args, runtimeDir, 20000);
            AppendLog("补丁输出：" + Shorten(output, 600));
        }

        private void RestorePatch()
        {
            string node = FindNode();
            string patch = Path.Combine(runtimeDir, "windsurf-native-patch.mjs");
            string apiUrl = "http://localhost:" + config.port;
            string args = Quote(patch) + " restore --windsurfPath " + Quote(config.windsurfPath) + " --apiUrl " + Quote(apiUrl);
            AppendLog("正在恢复 Windsurf 原生补丁...");
            string output = RunCapture(node, args, runtimeDir, 20000);
            AppendLog("恢复输出：" + Shorten(output, 600));
        }

        private void ValidatePatchPrerequisites()
        {
            if (config.windsurfPath == null || !File.Exists(config.windsurfPath))
                throw new InvalidOperationException("没有找到 Windsurf.exe：" + config.windsurfPath);
            string node = FindNode();
            if (node.Length == 0)
                throw new InvalidOperationException("没有找到 Node.js。请安装 Node.js，或把 node.exe 加入 PATH。");
        }

        private void StartProxy()
        {
            string node = FindNode();
            string proxy = Path.Combine(runtimeDir, "windsurf-native-proxy.mjs");
            if (File.Exists(stdoutLog)) File.Delete(stdoutLog);
            if (File.Exists(stderrLog)) File.Delete(stderrLog);
            stdoutOffset = 0;
            stderrOffset = 0;

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = Quote(proxy);
            psi.WorkingDirectory = runtimeDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.EnvironmentVariables["WINDSURF_PROXY_CONFIG"] = configPath;

            proxyProcess = new Process();
            proxyProcess.StartInfo = psi;
            proxyProcess.EnableRaisingEvents = true;
            proxyProcess.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) AppendProxyLog(stdoutLog, e.Data);
            };
            proxyProcess.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) AppendProxyLog(stderrLog, e.Data);
            };
            proxyProcess.Exited += delegate
            {
                AppendRawAppLog(DateTime.Now.ToString("HH:mm:ss") + "  代理进程已退出。");
            };
            proxyProcess.Start();
            proxyProcess.BeginOutputReadLine();
            proxyProcess.BeginErrorReadLine();
            AppendLog("已启动代理进程，PID：" + proxyProcess.Id);
        }

        private async Task StopProxyAsync()
        {
            if (proxyActionInProgress) return;
            try
            {
                proxyActionInProgress = true;
                startButton.Enabled = false;
                stopButton.Enabled = false;
                UseWaitCursor = true;
                SetStatus(false, "正在停止", "127.0.0.1:" + (int)portBox.Value);
                int port = (int)portBox.Value;
                int count = await Task.Run(delegate { return StopTrackedProxyProcess(); });
                bool portListening = count == 0 && await Task.Run(delegate { return IsPortListening(port); });
                if (portListening)
                {
                    if (ConfirmStopPortProcess(port))
                    {
                        count = await Task.Run(delegate { return StopProcessesOnPort(port); });
                    }
                    else
                    {
                        AppendLog("端口仍被占用，但没有停止非本程序启动的进程。");
                    }
                }
                AppendLog("已停止代理进程数：" + count);
                await Task.Delay(600);
                await RefreshHealthAsync(true);
            }
            catch (Exception ex)
            {
                AppendLog("停止失败：" + ex.Message);
            }
            finally
            {
                UseWaitCursor = false;
                proxyActionInProgress = false;
                startButton.Enabled = true;
                stopButton.Enabled = true;
                UpdateStartButtonText();
            }
        }

        private void AppendProxyLog(string path, string line)
        {
            try
            {
                lock (proxyLogLock)
                {
                    File.AppendAllText(path, line + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { }
        }

        private bool IsTrackedProxyRunning()
        {
            try
            {
                return proxyProcess != null && !proxyProcess.HasExited;
            }
            catch
            {
                return false;
            }
        }

        private int StopTrackedProxyProcess()
        {
            Process process = proxyProcess;
            if (process == null) return 0;
            try
            {
                if (process.HasExited)
                {
                    proxyProcess = null;
                    return 0;
                }
                int pid = process.Id;
                process.Kill();
                process.WaitForExit(3000);
                proxyProcess = null;
                AppendLog("已停止本程序启动的代理进程，PID：" + pid);
                return 1;
            }
            catch (Exception ex)
            {
                proxyProcess = null;
                AppendLog("停止已跟踪代理进程失败：" + ex.Message);
                return 0;
            }
        }

        private bool ConfirmStopPortProcess(int port)
        {
            DialogResult result = MessageBox.Show(
                "端口 " + port + " 正在被其他进程占用。\r\n\r\n是否停止占用该端口的进程？",
                "端口被占用",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            return result == DialogResult.Yes;
        }

        private async Task LaunchWindsurfAsync()
        {
            try
            {
                Process[] running = Process.GetProcessesByName("Windsurf");
                if (running.Length > 0)
                {
                    DialogResult result = MessageBox.Show("Windsurf 正在运行。是否重启 Windsurf 以加载补丁？", "重启 Windsurf", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                    if (result == DialogResult.Yes)
                    {
                        for (int i = 0; i < running.Length; i++)
                        {
                            try { running[i].Kill(); } catch { }
                        }
                        await Task.Delay(1200);
                    }
                }
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = config.windsurfPath;
                psi.WorkingDirectory = Path.GetDirectoryName(config.windsurfPath);
                Process.Start(psi);
                AppendLog("已打开 Windsurf。");
            }
            catch (Exception ex)
            {
                AppendLog("无法打开 Windsurf：" + ex.Message);
            }
        }

        private async Task RefreshHealthAsync(bool noisy)
        {
            if (Interlocked.Exchange(ref healthRefreshInProgress, 1) != 0) return;
            int port = (int)portBox.Value;
            try
            {
                string body = await Task.Run(delegate { return HttpGet("http://127.0.0.1:" + port + "/health", 1800); });
                Dictionary<string, object> health = json.Deserialize<Dictionary<string, object>>(body);
                string model = health.ContainsKey("model") ? Convert.ToString(health["model"]) : "";
                string wire = health.ContainsKey("wire_api") ? Convert.ToString(health["wire_api"]) : "";
                string upstream = health.ContainsKey("upstream") ? Convert.ToString(health["upstream"]) : "";
                string lastStatus = health.ContainsKey("last_request_status") ? Convert.ToString(health["last_request_status"]) : "";
                string lastModel = health.ContainsKey("last_request_model") ? Convert.ToString(health["last_request_model"]) : "";
                SetStatus(true, "代理运行中", "端口：127.0.0.1:" + port);
                if (protocolStatusLabel != null) protocolStatusLabel.Text = "协议：" + WireApiDisplay(wire) + " / " + model;
                if (lastRequestLabel != null) lastRequestLabel.Text = lastStatus.Length == 0 ? "最近请求：无" : "最近请求：" + lastStatus + " / " + lastModel;
                if (noisy) AppendLog("状态正常：" + upstream);
            }
            catch (Exception ex)
            {
                SetStatus(false, "代理未启动", "127.0.0.1:" + port);
                if (protocolStatusLabel != null) protocolStatusLabel.Text = "协议：-";
                if (lastRequestLabel != null) lastRequestLabel.Text = "最近请求：-";
                if (noisy) AppendLog("状态检查失败：" + ex.Message);
            }
            finally
            {
                Interlocked.Exchange(ref healthRefreshInProgress, 0);
            }
        }

        private void RefreshPatchStatus(bool noisy)
        {
            string windsurfPath = windsurfPathBox == null ? (config.windsurfPath ?? "") : windsurfPathBox.Text.Trim();
            int port = portBox == null ? (config.port <= 0 ? 3009 : config.port) : (int)portBox.Value;
            string display = GetPatchStatus(windsurfPath, port, noisy);
            if (patchStatusLabel != null) patchStatusLabel.Text = display;
            if (noisy) AppendLog("补丁状态：" + display.Replace("补丁：", ""));
        }

        private async Task RefreshPatchStatusAsync(bool noisy)
        {
            if (Interlocked.Exchange(ref patchRefreshInProgress, 1) != 0) return;
            string windsurfPath = windsurfPathBox == null ? (config.windsurfPath ?? "") : windsurfPathBox.Text.Trim();
            int port = portBox == null ? (config.port <= 0 ? 3009 : config.port) : (int)portBox.Value;
            try
            {
                string display = await Task.Run(delegate { return GetPatchStatus(windsurfPath, port, noisy); });
                if (patchStatusLabel != null) patchStatusLabel.Text = display;
                if (noisy) AppendLog("补丁状态：" + display.Replace("补丁：", ""));
            }
            finally
            {
                Interlocked.Exchange(ref patchRefreshInProgress, 0);
            }
        }

        private string GetPatchStatus(string windsurfPath, int port, bool noisy)
        {
            string display = "补丁：未知";
            try
            {
                string node = FindNode();
                if (node.Length == 0) return "补丁：无 Node";
                if (windsurfPath.Length == 0 || !File.Exists(windsurfPath)) return "补丁：未找到 Windsurf";

                string patch = Path.Combine(runtimeDir, "windsurf-native-patch.mjs");
                string apiUrl = "http://localhost:" + port;
                string args = Quote(patch) + " check --windsurfPath " + Quote(windsurfPath) + " --apiUrl " + Quote(apiUrl);
                string output = RunCapture(node, args, runtimeDir, 15000);
                int applied = CountOccurrences(output, "\"status\": \"applied\"");
                int available = CountOccurrences(output, "\"status\": \"available\"");
                int missing = CountOccurrences(output, "\"status\": \"missing\"");
                if (applied >= 2) display = "补丁：已安装";
                else if (available > 0) display = "补丁：未安装";
                else if (missing > 0) display = "补丁：不兼容";
            }
            catch (Exception ex)
            {
                if (noisy) AppendLog("补丁状态检查失败：" + ex.Message);
            }
            return display;
        }

        private int CountOccurrences(string haystack, string needle)
        {
            if (String.IsNullOrEmpty(haystack) || String.IsNullOrEmpty(needle)) return 0;
            int count = 0;
            int index = 0;
            while ((index = haystack.IndexOf(needle, index, StringComparison.OrdinalIgnoreCase)) >= 0)
            {
                count++;
                index += needle.Length;
            }
            return count;
        }

        private bool WaitForHealth(int port, int timeoutMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                try
                {
                    HttpGet("http://127.0.0.1:" + port + "/health", 1500);
                    return true;
                }
                catch
                {
                    Thread.Sleep(400);
                }
            }
            return false;
        }

        private void SetStatus(bool ok, string title, string detail)
        {
            statusDot.ForeColor = ok ? success : danger;
            statusTitle.Text = title;
            statusDetail.Text = detail;
            startButton.Enabled = true;
            UpdateStartButtonText();
        }

        private void UpdateStartButtonText()
        {
            if (startButton == null || launchWindsurfBox == null) return;
            startButton.Text = launchWindsurfBox.Checked ? "启动并打开 Windsurf" : "启动代理";
        }

        private void TailProxyLogs()
        {
            TailOne(stdoutLog, ref stdoutOffset, false);
            TailOne(stderrLog, ref stderrOffset, true);
        }

        private async Task TailProxyLogsAsync()
        {
            if (Interlocked.Exchange(ref logTailInProgress, 1) != 0) return;
            try
            {
                await Task.Run(delegate { TailProxyLogs(); });
            }
            finally
            {
                Interlocked.Exchange(ref logTailInProgress, 0);
            }
        }

        private void TailOne(string path, ref long offset, bool isError)
        {
            if (!File.Exists(path)) return;
            try
            {
                FileInfo info = new FileInfo(path);
                if (info.Length < offset) offset = 0;
                if (info.Length == offset) return;
                using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    fs.Seek(offset, SeekOrigin.Begin);
                    using (StreamReader reader = new StreamReader(fs, Encoding.UTF8))
                    {
                        string chunk = reader.ReadToEnd();
                        offset = fs.Position;
                        if (chunk.Length > 0) AppendLog((isError ? "[stderr] " : "") + chunk.TrimEnd());
                    }
                }
            }
            catch { }
        }

        private string HttpGet(string url, int timeout)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Timeout = timeout;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                return reader.ReadToEnd();
            }
        }

        private bool IsPortListening(int port)
        {
            string output = RunCapture("netstat.exe", "-ano", runtimeDir, 10000);
            string needle = ":" + port;
            string[] lines = output.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < lines.Length; i++)
            {
                if (lines[i].IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0 &&
                    lines[i].IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) >= 0)
                    return true;
            }
            return false;
        }

        private int StopProcessesOnPort(int port)
        {
            string output = RunCapture("netstat.exe", "-ano", runtimeDir, 10000);
            HashSet<int> pids = new HashSet<int>();
            string needle = ":" + port;
            string[] lines = output.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0 ||
                    line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0)
                    continue;
                string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                int pid;
                if (parts.Length > 0 && int.TryParse(parts[parts.Length - 1], out pid))
                {
                    if (pid > 0 && pid != Process.GetCurrentProcess().Id) pids.Add(pid);
                }
            }

            int stopped = 0;
            foreach (int pid in pids)
            {
                try
                {
                    Process p = Process.GetProcessById(pid);
                    p.Kill();
                    stopped++;
                }
                catch { }
            }
            return stopped;
        }

        private string FindNode()
        {
            string fromPath = RunCapture("where.exe", "node", runtimeDir, 8000).Trim();
            if (fromPath.Length > 0)
            {
                string[] lines = fromPath.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                if (lines.Length > 0 && File.Exists(lines[0])) return lines[0];
            }
            string common = @"C:\Program Files\nodejs\node.exe";
            if (File.Exists(common)) return common;
            return "";
        }

        private string RunCapture(string fileName, string arguments, string workDir, int timeoutMs)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = fileName;
            psi.Arguments = arguments;
            psi.WorkingDirectory = workDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            Process p = Process.Start(psi);
            if (p == null) return "";
            string stdout = p.StandardOutput.ReadToEnd();
            string stderr = p.StandardError.ReadToEnd();
            if (!p.WaitForExit(timeoutMs))
            {
                try { p.Kill(); } catch { }
                throw new TimeoutException(fileName + " timed out.");
            }
            return stdout + stderr;
        }

        private void BrowseWindsurf()
        {
            OpenFileDialog d = new OpenFileDialog();
            d.Filter = "Windsurf.exe|Windsurf.exe|Executable files (*.exe)|*.exe|All files (*.*)|*.*";
            d.FileName = "Windsurf.exe";
            if (d.ShowDialog(this) == DialogResult.OK)
            {
                windsurfPathBox.Text = d.FileName;
            }
        }

        private void UpdateRouteCount()
        {
            int count = 0;
            if (routesGrid != null)
            {
                foreach (DataGridViewRow row in routesGrid.Rows)
                    if (!row.IsNewRow && Cell(row, "windsurf").Trim().Length > 0) count++;
            }
            if (routeCountLabel != null) routeCountLabel.Text = "路由：" + count;
        }

        private string NormalizeWireApi(string value)
        {
            string textValue = (value ?? "").Trim();
            if (String.Equals(textValue, "chat", StringComparison.OrdinalIgnoreCase) || textValue.IndexOf("OpenAI Chat", StringComparison.OrdinalIgnoreCase) >= 0) return "chat";
            if (String.Equals(textValue, "anthropic", StringComparison.OrdinalIgnoreCase) || textValue.IndexOf("Anthropic", StringComparison.OrdinalIgnoreCase) >= 0) return "anthropic";
            if (String.Equals(textValue, "messages", StringComparison.OrdinalIgnoreCase)) return "anthropic";
            if (String.Equals(textValue, "claude", StringComparison.OrdinalIgnoreCase)) return "anthropic";
            return "responses";
        }

        private string WireApiDisplay(string value)
        {
            string wire = NormalizeWireApi(value);
            if (wire == "chat") return "OpenAI Chat";
            if (wire == "anthropic") return "Anthropic Messages";
            return "OpenAI Responses";
        }

        private void AddThinkingEffortItems(ComboBox box, bool includeInherit, string wireApi)
        {
            if (box == null) return;
            box.Items.Clear();
            if (includeInherit) box.Items.Add("继承默认");
            box.Items.Add("默认（不指定）");
            string wire = NormalizeWireApi(wireApi);
            if (wire != "anthropic")
            {
                box.Items.Add("无");
                box.Items.Add("最小");
            }
            box.Items.Add("低");
            box.Items.Add("中");
            box.Items.Add("高");
            box.Items.Add("极高");
            if (wire == "anthropic") box.Items.Add("最高");
        }

        private void AddThinkingEffortItems(DataGridViewComboBoxColumn column, bool includeInherit)
        {
            if (includeInherit) column.Items.Add("继承默认");
            column.Items.Add("默认（不指定）");
            column.Items.Add("无");
            column.Items.Add("最小");
            column.Items.Add("低");
            column.Items.Add("中");
            column.Items.Add("高");
            column.Items.Add("极高");
            column.Items.Add("最高");
        }

        private string NormalizeThinkingMode(string value)
        {
            string textValue = (value ?? "").Trim();
            if (String.Equals(textValue, "disabled", StringComparison.OrdinalIgnoreCase) || textValue == "关闭") return "disabled";
            if (String.Equals(textValue, "adaptive", StringComparison.OrdinalIgnoreCase) || textValue == "自适应") return "adaptive";
            if (String.Equals(textValue, "enabled", StringComparison.OrdinalIgnoreCase) || textValue == "手动开启") return "enabled";
            return "default";
        }

        private string NormalizeRouteThinkingMode(string value)
        {
            string textValue = (value ?? "").Trim();
            if (textValue.Length == 0 || textValue == "继承默认") return "";
            return NormalizeThinkingMode(textValue);
        }

        private string ThinkingModeDisplay(string value, bool route)
        {
            string normalized = route ? NormalizeRouteThinkingMode(value) : NormalizeThinkingMode(value);
            if (route && normalized.Length == 0) return "继承默认";
            if (normalized == "disabled") return "关闭";
            if (normalized == "adaptive") return "自适应";
            if (normalized == "enabled") return "手动开启";
            return "默认（不指定）";
        }

        private string NormalizeThinkingEffort(string value)
        {
            string textValue = (value ?? "").Trim();
            if (String.Equals(textValue, "none", StringComparison.OrdinalIgnoreCase) || textValue == "无") return "none";
            if (String.Equals(textValue, "minimal", StringComparison.OrdinalIgnoreCase) || textValue == "最小") return "minimal";
            if (String.Equals(textValue, "low", StringComparison.OrdinalIgnoreCase) || textValue == "低") return "low";
            if (String.Equals(textValue, "medium", StringComparison.OrdinalIgnoreCase) || textValue == "中") return "medium";
            if (String.Equals(textValue, "high", StringComparison.OrdinalIgnoreCase) || textValue == "高") return "high";
            if (String.Equals(textValue, "xhigh", StringComparison.OrdinalIgnoreCase) || textValue == "极高") return "xhigh";
            if (String.Equals(textValue, "max", StringComparison.OrdinalIgnoreCase) || textValue == "最高") return "max";
            return "default";
        }

        private string NormalizeRouteThinkingEffort(string value)
        {
            string textValue = (value ?? "").Trim();
            if (textValue.Length == 0 || textValue == "继承默认") return "";
            return NormalizeThinkingEffort(textValue);
        }

        private string ThinkingEffortDisplay(string value, bool route)
        {
            string normalized = route ? NormalizeRouteThinkingEffort(value) : NormalizeThinkingEffort(value);
            if (route && normalized.Length == 0) return "继承默认";
            if (normalized == "none") return "无";
            if (normalized == "minimal") return "最小";
            if (normalized == "low") return "低";
            if (normalized == "medium") return "中";
            if (normalized == "high") return "高";
            if (normalized == "xhigh") return "极高";
            if (normalized == "max") return "最高";
            return "默认（不指定）";
        }

        private int ParseRouteThinkingBudget(string value)
        {
            string textValue = (value ?? "").Trim();
            if (textValue.Length == 0) return -1;
            int parsed;
            if (!Int32.TryParse(textValue, out parsed)) return -1;
            if (parsed < 0) return -1;
            return Math.Min(parsed, 1000000);
        }

        private async void TestConnectionFromUi()
        {
            if (proxyActionInProgress) return;
            try
            {
                proxyActionInProgress = true;
                UseWaitCursor = true;
                SaveConfigFromUi();
                string baseUrl = config.openaiBaseUrl;
                string apiKey = config.openaiApiKey;
                string model = config.openaiModel;
                string wireApi = config.openaiWireApi;
                string thinkingMode = config.thinkingMode;
                string thinkingEffort = config.thinkingEffort;
                int thinkingBudgetTokens = config.thinkingBudgetTokens;
                string result = await Task.Run(delegate
                {
                    return TestUpstream(baseUrl, apiKey, model, wireApi, thinkingMode, thinkingEffort, thinkingBudgetTokens);
                });
                AppendLog("测试连接成功：" + result);
                MessageBox.Show(SummarizeTestResult(result, wireApi, model), "测试连接", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                AppendLog("测试连接失败：" + ex.Message);
                MessageBox.Show(ex.Message, "测试连接失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                UseWaitCursor = false;
                proxyActionInProgress = false;
            }
        }

        private string TestUpstream(string baseUrl, string apiKey, string model, string wireApi, string thinkingMode, string thinkingEffort, int thinkingBudgetTokens)
        {
            if (String.IsNullOrWhiteSpace(baseUrl)) throw new InvalidOperationException("接口地址不能为空。");
            if (String.IsNullOrWhiteSpace(apiKey)) throw new InvalidOperationException("API 密钥不能为空。");
            if (String.IsNullOrWhiteSpace(model)) throw new InvalidOperationException("模型不能为空。");
            string wire = NormalizeWireApi(wireApi);
            string endpoint = BuildEndpoint(baseUrl, wire, "");
            Dictionary<string, object> payload = new Dictionary<string, object>();
            WebHeaderCollection headers = new WebHeaderCollection();
            headers["Content-Type"] = "application/json";
            if (wire == "anthropic")
            {
                headers["x-api-key"] = apiKey;
                headers["anthropic-version"] = "2023-06-01";
                int maxTokens = 128;
                string mode = NormalizeThinkingMode(thinkingMode);
                string effort = NormalizeThinkingEffort(thinkingEffort);
                if (mode == "enabled")
                {
                    int budget = thinkingBudgetTokens > 0 ? thinkingBudgetTokens : 1024;
                    maxTokens = Math.Max(maxTokens, budget + 256);
                    payload["thinking"] = new Dictionary<string, object> { { "type", "enabled" }, { "budget_tokens", budget } };
                }
                else if (mode == "adaptive")
                {
                    payload["thinking"] = new Dictionary<string, object> { { "type", "adaptive" } };
                }
                else if (mode == "disabled")
                {
                    payload["thinking"] = new Dictionary<string, object> { { "type", "disabled" } };
                }
                if (IsAnthropicEffort(effort))
                {
                    payload["output_config"] = new Dictionary<string, object> { { "effort", effort } };
                }
                payload["model"] = model;
                payload["max_tokens"] = maxTokens;
                payload["stream"] = false;
                payload["messages"] = new object[]
                {
                    new Dictionary<string, object> { { "role", "user" }, { "content", "ping" } }
                };
            }
            else if (wire == "responses")
            {
                headers["Authorization"] = "Bearer " + apiKey;
                payload["model"] = model;
                payload["stream"] = false;
                payload["input"] = "ping";
                payload["max_output_tokens"] = 128;
                Dictionary<string, object> reasoning = ResponsesReasoningForTest(thinkingMode, thinkingEffort);
                if (reasoning != null) payload["reasoning"] = reasoning;
            }
            else
            {
                headers["Authorization"] = "Bearer " + apiKey;
                payload["model"] = model;
                payload["stream"] = false;
                payload["messages"] = new object[]
                {
                    new Dictionary<string, object> { { "role", "user" }, { "content", "ping" } }
                };
                payload["max_tokens"] = 128;
                AddChatThinkingForTest(payload, thinkingMode, thinkingEffort);
            }
            string body = json.Serialize(payload);
            return HttpPostJson(endpoint, headers, body, 30000);
        }

        private async void FetchModelsFromUi()
        {
            if (proxyActionInProgress) return;
            try
            {
                proxyActionInProgress = true;
                UseWaitCursor = true;
                string wire = NormalizeWireApi(Convert.ToString(wireApiBox.SelectedItem));
                string endpoint = BuildEndpoint(baseUrlBox.Text.Trim(), wire, "models");
                WebHeaderCollection headers = new WebHeaderCollection();
                if (wire == "anthropic")
                {
                    headers["x-api-key"] = apiKeyBox.Text.Trim();
                    headers["anthropic-version"] = "2023-06-01";
                }
                else
                {
                    headers["Authorization"] = "Bearer " + apiKeyBox.Text.Trim();
                }
                string raw = await Task.Run(delegate { return HttpGetWithHeaders(endpoint, headers, 20000); });
                string[] ids = ExtractModelIds(raw);
                if (ids.Length == 0)
                {
                    MessageBox.Show("没有从模型列表中识别到模型 ID。\r\n\r\n" + Shorten(raw, 1000), "模型列表", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                ModelPickerForm picker = new ModelPickerForm(ids);
                if (picker.ShowDialog(this) == DialogResult.OK && picker.SelectedModel.Length > 0)
                {
                    modelBox.Text = picker.SelectedModel;
                    AppendLog("已选择模型：" + picker.SelectedModel);
                }
            }
            catch (Exception ex)
            {
                AppendLog("拉取模型列表失败：" + ex.Message);
                MessageBox.Show(ex.Message, "拉取模型列表失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                UseWaitCursor = false;
                proxyActionInProgress = false;
            }
        }

        private string BuildEndpoint(string baseUrl, string wireApi, string explicitLeaf)
        {
            string baseClean = (baseUrl ?? "").Trim().TrimEnd('/');
            if (baseClean.Length == 0) throw new InvalidOperationException("接口地址不能为空。");
            if (explicitLeaf == "models")
            {
                return BaseUrlHasVersionPath(baseClean) ? baseClean + "/models" : baseClean + "/v1/models";
            }
            string leaf = NormalizeWireApi(wireApi) == "anthropic" ? "messages" : (NormalizeWireApi(wireApi) == "responses" ? "responses" : "chat/completions");
            return BaseUrlHasVersionPath(baseClean) ? baseClean + "/" + leaf : baseClean + "/v1/" + leaf;
        }

        private Dictionary<string, object> ResponsesReasoningForTest(string thinkingMode, string thinkingEffort)
        {
            string mode = NormalizeThinkingMode(thinkingMode);
            string effort = mode == "disabled" ? "none" : NormalizeThinkingEffort(thinkingEffort);
            if (effort == "default") return null;
            return new Dictionary<string, object> { { "effort", effort } };
        }

        private void AddChatThinkingForTest(Dictionary<string, object> payload, string thinkingMode, string thinkingEffort)
        {
            string effort = NormalizeThinkingEffort(thinkingEffort);
            if (effort != "default") payload["reasoning_effort"] = effort;
            string mode = NormalizeThinkingMode(thinkingMode);
            if (mode == "disabled")
            {
                payload["thinking"] = new Dictionary<string, object> { { "type", "disabled" } };
            }
            else if (mode == "enabled" || mode == "adaptive")
            {
                payload["thinking"] = new Dictionary<string, object> { { "type", "enabled" } };
            }
        }

        private bool IsAnthropicEffort(string effort)
        {
            return effort == "low" || effort == "medium" || effort == "high" || effort == "xhigh" || effort == "max";
        }

        private string SummarizeTestResult(string raw, string wireApi, string configuredModel)
        {
            try
            {
                Dictionary<string, object> root = json.Deserialize<Dictionary<string, object>>(raw);
                string returnedModel = DictString(root, "model");
                string requestModel = configuredModel ?? "";
                string status = DictString(root, "status");
                if (status.Length == 0) status = "ok";
                string textValue = ExtractResponseText(root);
                string returnedEffort = ExtractReturnedEffort(root);
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("测试连接成功。");
                sb.AppendLine();
                sb.AppendLine("接口类型：" + WireApiDisplay(wireApi));
                sb.AppendLine("请求模型：" + requestModel);
                if (returnedModel.Length > 0) sb.AppendLine("返回模型：" + returnedModel);
                sb.AppendLine("状态：" + status);
                if (textValue.Length > 0) sb.AppendLine("回复：" + Shorten(textValue, 120));
                if (returnedEffort.Length > 0) sb.AppendLine("返回思考强度：" + returnedEffort);
                sb.AppendLine();
                sb.AppendLine("原始响应已写入运行日志。");
                return sb.ToString();
            }
            catch
            {
                return "测试连接成功。\r\n\r\n原始响应已写入运行日志。";
            }
        }

        private string DictString(Dictionary<string, object> dict, string key)
        {
            if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return "";
            return Convert.ToString(dict[key]);
        }

        private Dictionary<string, object> DictObject(object value)
        {
            return value as Dictionary<string, object>;
        }

        private List<object> ListObject(object value)
        {
            List<object> list = new List<object>();
            object[] array = value as object[];
            if (array != null)
            {
                list.AddRange(array);
                return list;
            }
            ArrayList arrayList = value as ArrayList;
            if (arrayList != null)
            {
                foreach (object item in arrayList) list.Add(item);
            }
            return list;
        }

        private string ExtractResponseText(Dictionary<string, object> root)
        {
            string outputText = DictString(root, "output_text");
            if (outputText.Length > 0) return outputText;

            foreach (object choiceObj in ListObject(root.ContainsKey("choices") ? root["choices"] : null))
            {
                Dictionary<string, object> choice = DictObject(choiceObj);
                Dictionary<string, object> message = choice == null || !choice.ContainsKey("message") ? null : DictObject(choice["message"]);
                string content = DictString(message, "content");
                if (content.Length > 0) return content;
            }

            foreach (object contentObj in ListObject(root.ContainsKey("content") ? root["content"] : null))
            {
                Dictionary<string, object> content = DictObject(contentObj);
                string textValue = DictString(content, "text");
                if (textValue.Length > 0) return textValue;
            }

            foreach (object outputObj in ListObject(root.ContainsKey("output") ? root["output"] : null))
            {
                Dictionary<string, object> output = DictObject(outputObj);
                foreach (object contentObj in ListObject(output != null && output.ContainsKey("content") ? output["content"] : null))
                {
                    Dictionary<string, object> content = DictObject(contentObj);
                    string textValue = DictString(content, "text");
                    if (textValue.Length > 0) return textValue;
                }
            }
            return "";
        }

        private string ExtractReturnedEffort(Dictionary<string, object> root)
        {
            Dictionary<string, object> reasoning = root != null && root.ContainsKey("reasoning") ? DictObject(root["reasoning"]) : null;
            string effort = DictString(reasoning, "effort");
            if (effort.Length > 0) return effort;
            Dictionary<string, object> outputConfig = root != null && root.ContainsKey("output_config") ? DictObject(root["output_config"]) : null;
            return DictString(outputConfig, "effort");
        }

        private bool BaseUrlHasVersionPath(string baseUrl)
        {
            try
            {
                string path = new Uri(baseUrl).AbsolutePath.TrimEnd('/');
                return Regex.IsMatch(path, @"/v\d+$", RegexOptions.IgnoreCase);
            }
            catch { return false; }
        }

        private string HttpPostJson(string url, WebHeaderCollection headers, string body, int timeout)
        {
            byte[] data = Encoding.UTF8.GetBytes(body);
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "POST";
            request.Timeout = timeout;
            request.ContentType = "application/json";
            foreach (string key in headers.AllKeys)
            {
                if (String.Equals(key, "Content-Type", StringComparison.OrdinalIgnoreCase)) continue;
                request.Headers[key] = headers[key];
            }
            using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (WebException ex)
            {
                throw new InvalidOperationException(ReadWebException(ex));
            }
        }

        private string HttpGetWithHeaders(string url, WebHeaderCollection headers, int timeout)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Timeout = timeout;
            foreach (string key in headers.AllKeys) request.Headers[key] = headers[key];
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (WebException ex)
            {
                throw new InvalidOperationException(ReadWebException(ex));
            }
        }

        private string ReadWebException(WebException ex)
        {
            HttpWebResponse response = ex.Response as HttpWebResponse;
            if (response == null) return ex.Message;
            using (response)
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                return "HTTP " + (int)response.StatusCode + " " + response.StatusDescription + ":\r\n" + reader.ReadToEnd();
            }
        }

        private string[] ExtractModelIds(string raw)
        {
            List<string> ids = new List<string>();
            MatchCollection matches = Regex.Matches(raw ?? "", "\"id\"\\s*:\\s*\"([^\"]+)\"");
            foreach (Match match in matches)
            {
                string id = match.Groups[1].Value;
                if (id.Length > 0 && !ids.Contains(id)) ids.Add(id);
            }
            ids.Sort(StringComparer.OrdinalIgnoreCase);
            return ids.ToArray();
        }

        private string JsonEscape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private void CopyErrorLogs()
        {
            string text = ReadTail(stderrLog, 20000);
            if (text.Length == 0) text = ExtractErrorLines(logBox.Text);
            if (text.Length == 0)
            {
                MessageBox.Show("没有可复制的错误日志。", "复制错误", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Clipboard.SetText(text);
            AppendLog("已复制错误日志。");
        }

        private void ClearLogFiles()
        {
            DialogResult result = MessageBox.Show("这会清空运行日志和错误日志文件，但不会影响配置。是否继续？", "清空日志文件", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (result != DialogResult.Yes) return;
            try
            {
                File.WriteAllText(appLog, "", new UTF8Encoding(false));
                File.WriteAllText(stdoutLog, "", new UTF8Encoding(false));
                File.WriteAllText(stderrLog, "", new UTF8Encoding(false));
                stdoutOffset = 0;
                stderrOffset = 0;
                logBox.Clear();
                AppendLog("已清空日志文件。");
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "清空日志失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string ExtractErrorLines(string textValue)
        {
            List<string> lines = new List<string>();
            string[] split = (textValue ?? "").Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string line in split)
            {
                if (line.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    line.IndexOf("失败", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    line.IndexOf("HTTP 4", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    line.IndexOf("HTTP 5", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    line.IndexOf("[stderr]", StringComparison.OrdinalIgnoreCase) >= 0)
                    lines.Add(line);
            }
            return String.Join(Environment.NewLine, lines.ToArray());
        }

        private bool IsErrorLogText(string textValue)
        {
            string value = textValue ?? "";
            return value.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("失败", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("错误", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("HTTP 4", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("HTTP 5", StringComparison.OrdinalIgnoreCase) >= 0 ||
                value.IndexOf("[stderr]", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private string Quote(string value)
        {
            return "\"" + (value ?? "").Replace("\"", "\"\"") + "\"";
        }

        private string Shorten(string value, int max)
        {
            if (value == null) return "";
            value = value.Trim();
            return value.Length <= max ? value : value.Substring(0, max) + "...";
        }

        private string ReadTail(string path, int maxChars)
        {
            if (!File.Exists(path)) return "";
            string data = File.ReadAllText(path, Encoding.UTF8);
            if (data.Length <= maxChars) return data;
            return data.Substring(data.Length - maxChars);
        }

        private void AppendLog(string message)
        {
            string line = DateTime.Now.ToString("HH:mm:ss") + "  " + message;
            if (logBox != null)
            {
                if (logBox.InvokeRequired)
                {
                    logBox.BeginInvoke(new Action<string>(AppendLog), message);
                    return;
                }
                bool hiddenByFilter = onlyErrorLogsBox != null && onlyErrorLogsBox.Checked && !IsErrorLogText(line);
                if (!hiddenByFilter)
                {
                    if (logBox.TextLength > 100000) logBox.Clear();
                    logBox.AppendText(line + Environment.NewLine);
                }
            }
            AppendRawAppLog(line);
        }

        private void AppendRawAppLog(string line)
        {
            try
            {
                File.AppendAllText(appLog, line + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        private void OpenFile(string path)
        {
            try
            {
                if (!File.Exists(path)) File.WriteAllText(path, "", Encoding.UTF8);
                Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "打开失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OpenFolder(string path)
        {
            try
            {
                Directory.CreateDirectory(path);
                Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "打开失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string PrettyJson(string compact)
        {
            StringBuilder sb = new StringBuilder();
            int indent = 0;
            bool quoted = false;
            for (int i = 0; i < compact.Length; i++)
            {
                char ch = compact[i];
                if (ch == '"' && (i == 0 || compact[i - 1] != '\\')) quoted = !quoted;
                if (!quoted && (ch == '{' || ch == '['))
                {
                    sb.Append(ch);
                    sb.AppendLine();
                    indent++;
                    sb.Append(new string(' ', indent * 2));
                }
                else if (!quoted && (ch == '}' || ch == ']'))
                {
                    sb.AppendLine();
                    indent--;
                    sb.Append(new string(' ', indent * 2));
                    sb.Append(ch);
                }
                else if (!quoted && ch == ',')
                {
                    sb.Append(ch);
                    sb.AppendLine();
                    sb.Append(new string(' ', indent * 2));
                }
                else if (!quoted && ch == ':')
                {
                    sb.Append(": ");
                }
                else
                {
                    sb.Append(ch);
                }
            }
            return sb.ToString();
        }
    }

    internal sealed class ModelPickerForm : Form
    {
        private readonly ListBox list;
        public string SelectedModel = "";

        public ModelPickerForm(string[] models)
        {
            Text = "选择模型";
            StartPosition = FormStartPosition.CenterParent;
            Size = new Size(520, 460);
            Font = new Font("Segoe UI", 10F);

            list = new ListBox();
            list.Location = new Point(16, 16);
            list.Size = new Size(470, 340);
            list.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            list.Items.AddRange(models);
            Controls.Add(list);

            Button ok = new Button();
            ok.Text = "使用选中模型";
            ok.Location = new Point(282, 372);
            ok.Size = new Size(128, 34);
            ok.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            ok.Click += delegate { AcceptSelection(); };
            Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.Location = new Point(420, 372);
            cancel.Size = new Size(66, 34);
            cancel.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            Controls.Add(cancel);

            list.DoubleClick += delegate { AcceptSelection(); };
        }

        private void AcceptSelection()
        {
            if (list.SelectedItem == null) return;
            SelectedModel = Convert.ToString(list.SelectedItem);
            DialogResult = DialogResult.OK;
            Close();
        }
    }

    internal sealed class RouteEditorForm : Form
    {
        private readonly ComboBox windsurfBox;
        private readonly TextBox baseUrlBox;
        private readonly TextBox apiKeyBox;
        private readonly TextBox modelBox;
        private readonly ComboBox wireBox;
        private readonly ComboBox thinkingModeBox;
        private readonly ComboBox thinkingEffortBox;
        private readonly NumericUpDown budgetBox;
        private readonly Label thinkingModeLabel;
        private readonly Label thinkingEffortLabel;
        private readonly Label budgetLabel;
        private readonly Label thinkingHelpLabel;

        public string WindsurfModel = "";
        public string BaseUrl = "";
        public string ApiKey = "";
        public string Model = "";
        public string WireApi = "chat";
        public string ThinkingMode = "";
        public string ThinkingEffort = "";
        public int ThinkingBudgetTokens = -1;

        public RouteEditorForm(string windsurf, string baseUrl, string apiKey, string model, string wireApi, string thinkingMode, string thinkingEffort, int thinkingBudget, string[] windsurfModelChoices)
        {
            Text = "编辑模型路由";
            StartPosition = FormStartPosition.CenterParent;
            Size = new Size(780, 580);
            Font = new Font("Segoe UI", 10F);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;

            Controls.Add(Label("Windsurf 模型 ID", 24, 18, 220));
            windsurfBox = new ComboBox();
            windsurfBox.DropDownStyle = ComboBoxStyle.DropDown;
            windsurfBox.AutoCompleteMode = AutoCompleteMode.SuggestAppend;
            windsurfBox.AutoCompleteSource = AutoCompleteSource.ListItems;
            if (windsurfModelChoices != null)
            {
                for (int i = 0; i < windsurfModelChoices.Length; i++)
                {
                    if (!String.IsNullOrWhiteSpace(windsurfModelChoices[i]) && !windsurfBox.Items.Contains(windsurfModelChoices[i]))
                        windsurfBox.Items.Add(windsurfModelChoices[i]);
                }
            }
            windsurfBox.Location = new Point(24, 42);
            windsurfBox.Size = new Size(700, 32);
            windsurfBox.Text = windsurf ?? "";
            Controls.Add(windsurfBox);

            baseUrlBox = TextInput("接口地址", 24, 112, 700, baseUrl);
            apiKeyBox = TextInput("API 密钥（留空使用默认）", 24, 182, 700, apiKey);
            modelBox = TextInput("中转模型", 24, 252, 340, model);

            Label wireLabel = Label("接口类型", 386, 230, 220);
            Controls.Add(wireLabel);
            wireBox = new ComboBox();
            wireBox.DropDownStyle = ComboBoxStyle.DropDownList;
            wireBox.Items.Add("OpenAI Responses");
            wireBox.Items.Add("OpenAI Chat");
            wireBox.Items.Add("Anthropic Messages");
            wireBox.Location = new Point(386, 252);
            wireBox.Size = new Size(338, 32);
            wireBox.SelectedItem = WireDisplay(wireApi);
            if (wireBox.SelectedIndex < 0) wireBox.SelectedIndex = 1;
            Controls.Add(wireBox);

            thinkingModeLabel = Label("思考模式", 24, 314, 180);
            Controls.Add(thinkingModeLabel);
            thinkingModeBox = new ComboBox();
            thinkingModeBox.DropDownStyle = ComboBoxStyle.DropDownList;
            thinkingModeBox.Items.Add("继承默认");
            thinkingModeBox.Items.Add("默认（不指定）");
            thinkingModeBox.Items.Add("关闭");
            thinkingModeBox.Items.Add("自适应");
            thinkingModeBox.Items.Add("手动开启");
            thinkingModeBox.Location = new Point(24, 338);
            thinkingModeBox.Size = new Size(200, 32);
            thinkingModeBox.SelectedItem = ModeDisplay(thinkingMode);
            if (thinkingModeBox.SelectedIndex < 0) thinkingModeBox.SelectedIndex = 0;
            Controls.Add(thinkingModeBox);

            thinkingEffortLabel = Label("思考强度", 250, 314, 220);
            Controls.Add(thinkingEffortLabel);
            thinkingEffortBox = new ComboBox();
            thinkingEffortBox.DropDownStyle = ComboBoxStyle.DropDownList;
            thinkingEffortBox.Location = new Point(250, 338);
            thinkingEffortBox.Size = new Size(200, 32);
            Controls.Add(thinkingEffortBox);

            budgetLabel = Label("思考预算（0=继承）", 476, 314, 220);
            Controls.Add(budgetLabel);
            budgetBox = new NumericUpDown();
            budgetBox.Minimum = 0;
            budgetBox.Maximum = 1000000;
            budgetBox.ThousandsSeparator = true;
            budgetBox.Location = new Point(476, 338);
            budgetBox.Size = new Size(248, 32);
            budgetBox.Value = thinkingBudget < 0 ? 0 : thinkingBudget;
            Controls.Add(budgetBox);

            thinkingHelpLabel = Label("", 24, 384, 700);
            thinkingHelpLabel.ForeColor = Color.DimGray;
            thinkingHelpLabel.Size = new Size(700, 42);
            Controls.Add(thinkingHelpLabel);

            thinkingModeBox.SelectedIndexChanged += delegate
            {
                budgetBox.Enabled = NormalizeWire(Convert.ToString(wireBox.SelectedItem)) == "anthropic" &&
                    NormalizeMode(Convert.ToString(thinkingModeBox.SelectedItem)) == "enabled";
            };
            wireBox.SelectedIndexChanged += delegate { UpdateThinkingControls(); };
            UpdateThinkingControls(thinkingEffort);

            Button ok = new Button();
            ok.Text = "保存";
            ok.Location = new Point(548, 468);
            ok.Size = new Size(84, 36);
            ok.Click += delegate { Accept(); };
            Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.Location = new Point(640, 468);
            cancel.Size = new Size(84, 36);
            cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            Controls.Add(cancel);
        }

        private TextBox TextInput(string label, int x, int y, int w, string value)
        {
            Controls.Add(Label(label, x, y - 24, Math.Max(220, w)));
            TextBox box = new TextBox();
            box.Location = new Point(x, y);
            box.Size = new Size(w, 32);
            box.Text = value ?? "";
            Controls.Add(box);
            return box;
        }

        private Label Label(string text, int x, int y, int w)
        {
            Label label = new Label();
            label.Text = text;
            label.Location = new Point(x, y);
            label.Size = new Size(w, 22);
            return label;
        }

        private void UpdateThinkingControls()
        {
            UpdateThinkingControls(NormalizeEffort(Convert.ToString(thinkingEffortBox.SelectedItem)));
        }

        private void UpdateThinkingControls(string selectedEffort)
        {
            string wire = NormalizeWire(Convert.ToString(wireBox.SelectedItem));
            bool anthropic = wire == "anthropic";

            thinkingEffortBox.Items.Clear();
            thinkingEffortBox.Items.Add("继承默认");
            thinkingEffortBox.Items.Add("默认（不指定）");
            if (!anthropic)
            {
                thinkingEffortBox.Items.Add("无");
                thinkingEffortBox.Items.Add("最小");
            }
            thinkingEffortBox.Items.Add("低");
            thinkingEffortBox.Items.Add("中");
            thinkingEffortBox.Items.Add("高");
            thinkingEffortBox.Items.Add("极高");
            if (anthropic) thinkingEffortBox.Items.Add("最高");

            string selectedDisplay = EffortDisplay(selectedEffort);
            thinkingEffortBox.SelectedItem = thinkingEffortBox.Items.Contains(selectedDisplay) ? selectedDisplay : "继承默认";

            thinkingModeLabel.Visible = anthropic;
            thinkingModeBox.Visible = anthropic;
            budgetLabel.Visible = anthropic;
            budgetBox.Visible = anthropic;
            budgetBox.Enabled = anthropic && NormalizeMode(Convert.ToString(thinkingModeBox.SelectedItem)) == "enabled";

            if (anthropic)
            {
                thinkingEffortLabel.Text = "思考强度";
                thinkingEffortLabel.Location = new Point(250, 314);
                thinkingEffortBox.Location = new Point(250, 338);
                thinkingEffortBox.Size = new Size(200, 32);
                thinkingHelpLabel.Text = "Anthropic：思考模式控制 thinking；强度使用 output_config.effort；预算仅用于“手动开启”。";
            }
            else
            {
                thinkingEffortLabel.Text = wire == "responses" ? "推理强度（reasoning.effort）" : "推理强度（reasoning_effort）";
                thinkingEffortLabel.Location = new Point(24, 314);
                thinkingEffortBox.Location = new Point(24, 338);
                thinkingEffortBox.Size = new Size(340, 32);
                thinkingHelpLabel.Text = wire == "responses"
                    ? "OpenAI Responses：该路由只发送 reasoning.effort。"
                    : "OpenAI Chat：该路由只发送 reasoning_effort。";
            }
        }

        private void Accept()
        {
            WindsurfModel = windsurfBox.Text.Trim();
            BaseUrl = baseUrlBox.Text.Trim();
            ApiKey = apiKeyBox.Text.Trim();
            Model = modelBox.Text.Trim();
            WireApi = NormalizeWire(Convert.ToString(wireBox.SelectedItem));
            ThinkingEffort = NormalizeEffort(Convert.ToString(thinkingEffortBox.SelectedItem));
            if (WireApi == "anthropic")
            {
                ThinkingMode = NormalizeMode(Convert.ToString(thinkingModeBox.SelectedItem));
                ThinkingBudgetTokens = budgetBox.Value <= 0 ? -1 : (int)budgetBox.Value;
            }
            else
            {
                ThinkingMode = "default";
                ThinkingBudgetTokens = -1;
            }
            if (WindsurfModel.Length == 0)
            {
                MessageBox.Show("Windsurf 模型 ID 不能为空。", "编辑路由", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            DialogResult = DialogResult.OK;
            Close();
        }

        private string WireDisplay(string wire)
        {
            string normalized = NormalizeWire(wire);
            if (normalized == "anthropic") return "Anthropic Messages";
            if (normalized == "responses") return "OpenAI Responses";
            return "OpenAI Chat";
        }

        private string NormalizeWire(string wire)
        {
            if ((wire ?? "").IndexOf("Anthropic", StringComparison.OrdinalIgnoreCase) >= 0 || String.Equals(wire, "anthropic", StringComparison.OrdinalIgnoreCase)) return "anthropic";
            if ((wire ?? "").IndexOf("Responses", StringComparison.OrdinalIgnoreCase) >= 0 || String.Equals(wire, "responses", StringComparison.OrdinalIgnoreCase)) return "responses";
            return "chat";
        }

        private string ModeDisplay(string mode)
        {
            if (mode == "disabled") return "关闭";
            if (mode == "adaptive") return "自适应";
            if (mode == "enabled") return "手动开启";
            if (mode == "default") return "默认（不指定）";
            return "继承默认";
        }

        private string NormalizeMode(string mode)
        {
            if (mode == "关闭") return "disabled";
            if (mode == "自适应") return "adaptive";
            if (mode == "手动开启") return "enabled";
            if (mode == "默认（不指定）") return "default";
            return "";
        }

        private string EffortDisplay(string effort)
        {
            if (effort == "none") return "无";
            if (effort == "minimal") return "最小";
            if (effort == "low") return "低";
            if (effort == "medium") return "中";
            if (effort == "high") return "高";
            if (effort == "xhigh") return "极高";
            if (effort == "max") return "最高";
            if (effort == "default") return "默认（不指定）";
            return "继承默认";
        }

        private string NormalizeEffort(string effort)
        {
            if (effort == "无") return "none";
            if (effort == "最小") return "minimal";
            if (effort == "低") return "low";
            if (effort == "中") return "medium";
            if (effort == "高") return "high";
            if (effort == "极高") return "xhigh";
            if (effort == "最高") return "max";
            if (effort == "默认（不指定）") return "default";
            return "";
        }
    }
}
