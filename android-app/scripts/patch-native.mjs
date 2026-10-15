#!/usr/bin/env node
/* patch-native.mjs — Capacitor 原生工程定制（幂等，可随 cap sync 反复执行）
 * 1. 允许第三方 Cookie（WebView 内 SPA 跨域访问自托管服务器时会话 Cookie 正常）；
 * 2. 从 assets/public/index.html 解析内置服务器地址，得到可信主机白名单；
 * 3. 对可信主机放行 SSL 错误（自签名 / 证书链不完整，如 Synology NAS）；
 * 4. web 层热更新：启动加载 files/www 已下载版本，后台拉 /api/app/manifest 比对指纹，
 *    全量下载到 www-new 并逐文件 sha256 校验，原子替换后 setServerBasePath 热刷新。
 * 5. APK 自更新：manifest 内含更高 versionCode 时后台下载 APK 并校验 sha256，
 *    弹窗由用户确认后经 FileProvider 拉起系统安装器（Android 不允许非系统应用静默安装）；
 *    web 层热更新逻辑不变，无新 APK 时完全静默。
 * 6. 版本号注入：versionCode/versionName 由 android-app/package.json 的 version 推导。
 * 7. 签名与权限：注入 release signingConfigs（读 CI 注入的 TE_KEYSTORE_* 环境变量）
 *    与 REQUEST_INSTALL_PACKAGES 权限。
 * MainActivity 已含标记时跳过写入（不覆盖用户改动）；gradle/manifest 补丁始终幂等执行。
 * 注意：content 使用 String.raw，Java 中的反斜杠（\n、\"、\\）原样保留，无需双写。 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'android/app/src/main/java/com/hanyuestar/travelexpense/MainActivity.java');
const MARKER = '// TE_NATIVE_PATCHED_V2';
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

let needWriteJava = true;
if (existsSync(target)) {
  const cur = readFileSync(target, 'utf8');
  if (cur.includes(MARKER)) {
    needWriteJava = false;
    console.log('[patch-native] MainActivity 已是最新定制，跳过写入');
  } else {
    console.log('[patch-native] MainActivity 为旧版/未定制，将覆盖写入新版');
  }
}

const content = String.raw`package com.hanyuestar.travelexpense;
// TE_NATIVE_PATCHED_V2

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.provider.Settings;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/* 原生定制（由 scripts/patch-native.mjs 幂等注入，勿手改后再跑 sync，会被跳过）：
 * 1. 允许第三方 Cookie（WebView 内 SPA 跨域访问自托管服务器时保证会话 Cookie 正常）；
 * 2. 从 assets/public/index.html 解析内置服务器地址，得到可信主机白名单与 baseUrl；
 * 3. 对可信主机放行 SSL 错误（自签名 / 证书链不完整，如 Synology NAS）；
 * 4. web 层热更新：启动加载 files/www 已下载版本，后台拉 /api/app/manifest 比对指纹，
 *    全量下载到 www-new 并逐文件 sha256 校验，原子替换后 setServerBasePath 热刷新。 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "TEHotUpdate";
    private final Set<String> trustedHosts = new HashSet<>();
    private String serverBaseUrl = "";
    private String builtinServerUrl = "";
    private SSLSocketFactory trustAllFactory = null;

    /* 5. APK 自更新：与 web 热更新共用一次 manifest 请求 */
    private static final String PREF_APK = "te_app_update";
    private volatile int pendingApkVersion = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        enableThirdPartyCookies();
        loadBuiltinServer();
        installSslErrorHandler();
        applyDownloadedBundle();   // 第二次启动直接进上次下载的新版本
        startHotUpdateCheck();     // 后台静默检查并热更新 web 资源
    }

    /* 1. 允许第三方 Cookie */
    private void enableThirdPartyCookies() {
        try {
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setAcceptThirdPartyCookies(this.bridge.getWebView(), true);
        } catch (Exception e) {
            Log.e(TAG, "enableThirdPartyCookies failed", e);
        }
    }

    /* 2. 解析打包进 assets 的 index.html 中的内置服务器地址，填充 host 白名单与 baseUrl */
    private void loadBuiltinServer() {
        String html = readAssetText("public/index.html");
        Matcher m = Pattern.compile("TE_BUILTIN_SERVER=\\\"([^\\\"]+)\\\"").matcher(html);
        if (m.find()) {
            try {
                URL u = new URL(m.group(1));
                trustedHosts.add(u.getHost().toLowerCase());
                int port = u.getPort();
                serverBaseUrl = u.getProtocol() + "://" + u.getHost() + (port != -1 ? ":" + port : "");
                builtinServerUrl = m.group(1).replaceAll("/+$", "");
            } catch (Exception e) {
                Log.e(TAG, "解析内置服务器地址失败", e);
            }
        }
    }

    private String readAssetText(String name) {
        StringBuilder sb = new StringBuilder();
        try (InputStream is = getAssets().open(name);
             BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
        } catch (Exception e) {
            Log.e(TAG, "读取 asset 失败: " + name, e);
        }
        return sb.toString();
    }

    /* 3. 对可信主机放行 SSL 错误（自签名 / 证书链不完整），其余主机一律取消。
     *    必须继承 BridgeWebViewClient 而非裸 WebViewClient：父类的 shouldInterceptRequest
     *    负责把 http://localhost 拦截到 assets / files 目录（热更新 setServerBasePath 依赖它），
     *    裸 WebViewClient 会丢失该拦截导致白屏。通过 bridge.setWebViewClient 安装以同步内部引用。 */
    private void installSslErrorHandler() {
        this.bridge.setWebViewClient(new BridgeWebViewClient(this.bridge) {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                String host = "";
                try {
                    String h = Uri.parse(error.getUrl()).getHost();
                    if (h != null) host = h;
                } catch (Exception ignore) { }
                if (host != null && trustedHosts.contains(host.toLowerCase())) handler.proceed();
                else handler.cancel();
            }
        });
    }

    /* ================= 4. 热更新（web 层） ================= */

    private File wwwDir() { return new File(getFilesDir(), "www"); }
    private File wwwNewDir() { return new File(getFilesDir(), "www-new"); }
    private static File manifestIn(File dir) { return new File(dir, ".manifest.json"); }

    /* 启动时若 files/www 已存在（上次下载的版本），立即切换资源根目录，避免先加载 assets 再刷新的闪烁 */
    private void applyDownloadedBundle() {
        try {
            if (this.bridge == null) return;
            File idx = new File(wwwDir(), "index.html");
            if (idx.exists()) {
                this.bridge.setServerBasePath(wwwDir().getAbsolutePath());
                Log.i(TAG, "启动加载热更新版本: " + wwwDir().getAbsolutePath());
            }
        } catch (Exception e) {
            Log.e(TAG, "applyDownloadedBundle failed", e);
        }
    }

    private void startHotUpdateCheck() {
        if (serverBaseUrl == null || serverBaseUrl.isEmpty()) {
            Log.i(TAG, "未配置内置服务器地址，跳过热更新检查");
            return;
        }
        Thread t = new Thread(new Runnable() {
            @Override public void run() { checkUpdate(); }
        }, "te-hotupdate");
        t.setDaemon(true);
        t.start();
    }

    /* 后台检查并下载更新；任何失败都保留当前可运行版本，下次启动重试 */
    private void checkUpdate() {
        try {
            String manifestJson = httpGetString(serverBaseUrl + "/api/app/manifest");
            JSONObject envelope = new JSONObject(manifestJson);
            JSONObject remote = envelope.optJSONObject("data");
            if (remote == null) remote = envelope; // 兼容直接返回 manifest 的情况

            /* APK 自更新：无更高 versionCode 时完全静默，不影响下面的 web 热更新 */
            checkApkUpdate(remote.optJSONObject("apk"));

            final String remoteVersion = remote.optString("version", "");
            if (remoteVersion.isEmpty()) { Log.w(TAG, "manifest 缺少 version，跳过"); return; }

            /* 与本地版本指纹比对，一致则无需更新 */
            String localVersion = "";
            File lm = manifestIn(wwwDir());
            if (lm.exists()) {
                try { localVersion = new JSONObject(readFileText(lm)).optString("version", ""); } catch (Exception ignore) { }
            }
            if (remoteVersion.equals(localVersion) && new File(wwwDir(), "index.html").exists()) {
                Log.i(TAG, "web 资源已是最新版本: " + remoteVersion);
                return;
            }

            /* 全量下载到临时目录 www-new（public 文件少、体积小，全量比增量复制更简单可靠） */
            File newDir = wwwNewDir();
            deleteRecursive(newDir);
            if (!newDir.mkdirs() && !newDir.isDirectory()) { Log.e(TAG, "创建 www-new 失败"); return; }

            JSONArray files = remote.getJSONArray("files");
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                downloadVerifiedFile(f.getString("path"), f.getString("sha256"), newDir);
            }
            if (!reinjectBuiltinServer(newDir)) {
                deleteRecursive(newDir);
                Log.e(TAG, "内置服务器地址注入失败，放弃本次更新以保留当前可用版本");
                return;
            }
            writeBytes(manifestIn(newDir), remote.toString().getBytes(StandardCharsets.UTF_8));

            /* 原子替换：旧 www 先改名 www-old，新目录改名 www，成功后删除备份，失败回滚 */
            File curDir = wwwDir();
            File backup = new File(getFilesDir(), "www-old");
            deleteRecursive(backup);
            boolean swapped = false;
            if (curDir.exists()) {
                if (curDir.renameTo(backup)) {
                    if (newDir.renameTo(curDir)) { swapped = true; deleteRecursive(backup); }
                    else { backup.renameTo(curDir); } // 回滚
                }
            } else {
                swapped = newDir.renameTo(curDir);
            }
            if (!swapped) { deleteRecursive(newDir); Log.e(TAG, "目录替换失败，保留当前版本"); return; }

            Log.i(TAG, "web 资源已更新到版本: " + remoteVersion);
            final String basePath = curDir.getAbsolutePath();
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        if (bridge != null) {
                            bridge.setServerBasePath(basePath);
                            Toast.makeText(MainActivity.this, "已更新到最新版本", Toast.LENGTH_SHORT).show();
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "热刷新失败", e);
                    }
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "热更新检查失败（保留当前版本）: " + e.getMessage());
            deleteRecursive(wwwNewDir());
        }
    }

    /* ================= 5. APK 自更新（原生包） =================
     * 只有服务端提供更高 versionCode 的 APK 时才提示，否则完全静默（web 层继续热更新）。
     * Android 不允许非系统应用静默安装，故流程为：
     * 后台下载 + sha256 校验 → 应用内弹窗 → 用户点「立即安装」→ 系统安装器确认一次。
     * 覆盖安装保留应用数据（本地待同步队列不丢）；选「稍后」按版本号记忆，不再重复打扰。 */
    private void checkApkUpdate(JSONObject apk) {
        if (apk == null) return;
        try {
            final int remoteVc = apk.optInt("versionCode", 0);
            final String remoteVn = apk.optString("versionName", "");
            final String expectSha = apk.optString("sha256", "");
            final long size = apk.optLong("size", 0);
            final String notes = apk.optString("notes", "");
            if (remoteVc <= 0) return;

            int localVc = 0;
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                localVc = pi.versionCode;
            } catch (Exception ignore) { }

            File cached = new File(getCacheDir(), "te-update.apk");
            if (remoteVc <= localVc) {
                if (cached.exists()) cached.delete();
                Log.i(TAG, "APK 已是最新（本机 " + localVc + " / 服务端 " + remoteVc + "）");
                return;
            }
            SharedPreferences sp = getSharedPreferences(PREF_APK, MODE_PRIVATE);
            if (sp.getInt("skipped_version", 0) >= remoteVc) {
                Log.i(TAG, "用户已忽略该版本，跳过提示: " + remoteVc);
                return;
            }

            byte[] data = httpGetBytes(serverBaseUrl + "/api/app/apk");
            String actual = sha256Hex(data);
            if (expectSha != null && !expectSha.isEmpty() && !actual.equalsIgnoreCase(expectSha)) {
                Log.e(TAG, "APK sha256 校验失败（期望 " + expectSha + " / 实际 " + actual + "），已放弃本次更新");
                return;
            }
            if (size > 0 && data.length != size) {
                Log.e(TAG, "APK 大小不符（期望 " + size + " / 实际 " + data.length + "），已放弃本次更新");
                return;
            }
            writeBytes(cached, data);
            Log.i(TAG, "新 APK 已下载: " + cached.getAbsolutePath() + "（" + data.length + " 字节）");
            promptApkInstall(cached, remoteVc, remoteVn, data.length, notes);
        } catch (Exception e) {
            Log.w(TAG, "APK 更新检查失败（保留当前版本，下次启动重试）: " + e.getMessage());
        }
    }

    private void promptApkInstall(final File apkFile, final int remoteVc, final String remoteVn, final long size, final String notes) {
        pendingApkVersion = remoteVc;
        final String mb = String.format(Locale.CHINA, "%.1f", size / 1048576.0);
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    String msg = "版本 " + remoteVn + "（" + mb + " MB）已下载完成，覆盖安装不会影响你的数据。"
                        + (notes == null || notes.isEmpty() ? "" : "\n\n" + notes);
                    new AlertDialog.Builder(MainActivity.this)
                        .setTitle("发现新版本")
                        .setMessage(msg)
                        .setPositiveButton("立即安装", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface dialog, int which) { installApk(apkFile); }
                        })
                        .setNegativeButton("稍后", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface dialog, int which) {
                                getSharedPreferences(PREF_APK, MODE_PRIVATE).edit()
                                    .putInt("skipped_version", pendingApkVersion).apply();
                                Log.i(TAG, "用户选择稍后，该版本不再提示: " + pendingApkVersion);
                            }
                        })
                        .setCancelable(false)
                        .show();
                } catch (Exception e) {
                    Log.e(TAG, "APK 更新提示失败", e);
                }
            }
        });
    }

    /* 拉起系统安装器（用户需在安装器里确认一次；未授权时先引导到本应用的授权页） */
    private void installApk(File apkFile) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
                Toast.makeText(this, "请先允许「旅行经费台」安装应用，再回来完成更新", Toast.LENGTH_LONG).show();
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                s.setData(Uri.parse("package:" + getPackageName()));
                startActivity(s);
                return;
            }
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(uri, "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(it);
        } catch (Exception e) {
            Log.e(TAG, "拉起安装器失败", e);
            Toast.makeText(this, "拉起安装器失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /* 下载单个文件并校验 sha256，校验不通过抛异常中止本次更新 */
    private void downloadVerifiedFile(String rel, String expectSha, File newDir) throws Exception {
        if (rel == null || rel.contains("..") || rel.startsWith("/") || rel.contains("\\")) {
            throw new Exception("非法文件路径: " + rel);
        }
        String enc = URLEncoder.encode(rel, "UTF-8").replace("+", "%20");
        byte[] data = httpGetBytes(serverBaseUrl + "/api/app/file?path=" + enc);
        String actual = sha256Hex(data);
        if (!actual.equalsIgnoreCase(expectSha)) {
            throw new Exception("文件校验失败 " + rel);
        }
        File out = new File(newDir, rel);
        File parent = out.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new Exception("无法创建目录: " + parent);
        }
        writeBytes(out, data);
    }

    /* 热更新会把打包时注入的内置服务器地址覆盖掉：服务器下发的 index.html 是通用自托管版，
     * 不含 window.TE_BUILTIN_SERVER 脚本。这里在原子替换前，把解析到的 builtinServerUrl
     * 重新写回下载目录的 index.html，保证 APK 用户始终使用内置地址、无需手填。 */
    private boolean reinjectBuiltinServer(File dir) {
        if (builtinServerUrl == null || builtinServerUrl.isEmpty()) return true;
        File idx = new File(dir, "index.html");
        if (!idx.exists()) return true;
        try {
            String html = readFileText(idx);
            if (html.contains("TE_BUILTIN_SERVER=")) return true; // 已含内置地址，避免重复注入
            String injection = "<script>window.TE_BUILTIN_SERVER=\"" + builtinServerUrl + "\";</script>";
            int moduleIdx = html.indexOf("<script type=\"module\"");
            if (moduleIdx == -1) {
                html = html.replace("</head>", injection + "\n</head>");
            } else {
                html = html.substring(0, moduleIdx) + injection + "\n" + html.substring(moduleIdx);
            }
            writeBytes(idx, html.getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (Exception e) {
            Log.e(TAG, "reinjectBuiltinServer failed", e);
            return false;
        }
    }

    /* ---------- HTTP（仅对可信主机放宽证书校验，HostnameVerifier 仍限定白名单） ---------- */
    private HttpURLConnection openGet(String urlStr) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        if (conn instanceof HttpsURLConnection) {
            HttpsURLConnection hs = (HttpsURLConnection) conn;
            if (trustedHosts.contains(url.getHost().toLowerCase())) {
                hs.setSSLSocketFactory(getTrustAllFactory());
                hs.setHostnameVerifier(new HostnameVerifier() {
                    @Override public boolean verify(String hostname, SSLSession session) {
                        return hostname != null && trustedHosts.contains(hostname.toLowerCase());
                    }
                });
            }
        }
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(40000);
        conn.setRequestMethod("GET");
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("Accept", "*/*");
        return conn;
    }

    private byte[] httpGetBytes(String urlStr) throws Exception {
        HttpURLConnection conn = openGet(urlStr);
        try {
            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while (is != null && (n = is.read(buf)) != -1) bos.write(buf, 0, n);
            if (is != null) is.close();
            byte[] data = bos.toByteArray();
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
            return data;
        } finally {
            conn.disconnect();
        }
    }

    private String httpGetString(String urlStr) throws Exception {
        return new String(httpGetBytes(urlStr), StandardCharsets.UTF_8);
    }

    private synchronized SSLSocketFactory getTrustAllFactory() throws Exception {
        if (trustAllFactory != null) return trustAllFactory;
        TrustManager[] tms = new TrustManager[]{ new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }};
        SSLContext sc = SSLContext.getInstance("TLS");
        sc.init(null, tms, new java.security.SecureRandom());
        trustAllFactory = sc.getSocketFactory();
        return trustAllFactory;
    }

    /* ---------- 文件 / 哈希工具 ---------- */
    private static void writeBytes(File f, byte[] data) throws IOException {
        File p = f.getParentFile();
        if (p != null && !p.exists()) p.mkdirs();
        try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(data); }
    }

    private static String readFileText(File f) throws IOException {
        byte[] b = new byte[(int) Math.max(f.length(), 0)];
        try (FileInputStream fis = new FileInputStream(f)) {
            int off = 0;
            while (off < b.length) {
                int r = fis.read(b, off, b.length - off);
                if (r == -1) break;
                off += r;
            }
        }
        return new String(b, StandardCharsets.UTF_8);
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        f.delete();
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(data);
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte x : d) sb.append(String.format(Locale.US, "%02x", x & 0xff));
        return sb.toString();
    }
}
`;

if (!content.includes(MARKER)) {
  console.error('[patch-native] 安全校验失败：生成内容缺少标记，中止');
  process.exit(1);
}
if (needWriteJava) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  console.log('[patch-native] MainActivity.java 已写入（Cookie + SSL 白名单 + web 热更新 + APK 自更新）');
}

/* ---------- 6. build.gradle：版本号（由 package.json 推导）+ release 签名 ---------- */
function patchBuildGradle() {
  const bp = join(root, 'android/app/build.gradle');
  if (!existsSync(bp)) { console.log('[patch-native] 未找到 app/build.gradle，跳过（先跑 cap add android）'); return; }
  let g = readFileSync(bp, 'utf8');
  const parts = String(pkgVersion).split('.').map((n) => parseInt(n, 10) || 0);
  const vc = (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
  const before = g;
  g = g.replace(/versionCode\s+\d+/, 'versionCode ' + vc);
  g = g.replace(/versionName\s+"[^"]*"/, 'versionName "' + pkgVersion + '"');

  if (!g.includes('// TE_SIGNING_PATCHED')) {
    // 1) signingConfigs 块（插在 buildTypes 之前）
    const signing = [
      '',
      '    // TE_SIGNING_PATCHED —— 由 scripts/patch-native.mjs 注入，随 cap sync 重生成，勿手改',
      '    signingConfigs {',
      '        release {',
      '            def ksPath = System.getenv("TE_KEYSTORE_FILE")',
      '            if (ksPath != null && !ksPath.isEmpty()) {',
      '                storeType "PKCS12"',
      '                storeFile file(ksPath)',
      '                storePassword System.getenv("TE_KEYSTORE_PASSWORD")',
      '                keyAlias System.getenv("TE_KEY_ALIAS")',
      '                keyPassword System.getenv("TE_KEYSTORE_PASSWORD")',
      '            }',
      '        }',
      '    }',
      '',
      ''
    ].join('\n');
    const btIdx = g.search(/^\s*buildTypes\s*\{/m);
    if (btIdx < 0) { console.log('[patch-native] build.gradle 未找到 buildTypes，跳过签名注入'); return; }
    g = g.slice(0, btIdx) + signing + g.slice(btIdx);
    // 2) release buildType 挂上签名（缺 keystore 时回退 debug，避免本地出未签名包）
    const btOpen = g.indexOf('buildTypes {');
    const relIdx = g.indexOf('release {', btOpen);
    if (relIdx > -1) {
      const at = relIdx + 'release {'.length;
      g = g.slice(0, at)
        + '\n            // TE_SIGNING_PATCHED\n            signingConfig System.getenv("TE_KEYSTORE_FILE") != null ? signingConfigs.release : signingConfigs.debug'
        + g.slice(at);
    }
  }
  if (!g.includes('androidx.core:core:$androidxCoreVersion')) {
    g = g.replace(/(\n\s*implementation project\(':capacitor-android'\))/,
      '\n    implementation "androidx.core:core:$androidxCoreVersion"$1');
  }
  if (g !== before) { writeFileSync(bp, g, 'utf8'); console.log('[patch-native] build.gradle 已注入（versionCode=' + vc + ' / versionName=' + pkgVersion + ' / release 签名）'); }
}

/* ---------- 7. AndroidManifest：APK 自更新所需安装权限 ---------- */
function patchAndroidManifest() {
  const mp = join(root, 'android/app/src/main/AndroidManifest.xml');
  if (!existsSync(mp)) { console.log('[patch-native] 未找到 AndroidManifest.xml，跳过'); return; }
  let m = readFileSync(mp, 'utf8');
  if (m.includes('REQUEST_INSTALL_PACKAGES')) return;
  const anchor = /([ \t]*)<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/;
  if (!anchor.test(m)) { console.log('[patch-native] AndroidManifest 未找到 INTERNET 权限锚点，跳过'); return; }
  m = m.replace(anchor,
    '$1<uses-permission android:name="android.permission.INTERNET" />\n' +
    '$1<!-- APP 内自动更新：允许拉起系统安装器安装已下载的新版 APK -->\n' +
    '$1<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />');
  writeFileSync(mp, m, 'utf8');
  console.log('[patch-native] AndroidManifest 已加入 REQUEST_INSTALL_PACKAGES');
}

patchBuildGradle();
patchAndroidManifest();
