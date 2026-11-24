package com.github.tvbox.osc.base;

import android.content.Context;
import android.content.Intent;
import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.graphics.BitmapFactory;
import android.graphics.drawable.BitmapDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.PermissionChecker;

import com.github.tvbox.osc.R;
import com.github.tvbox.osc.callback.EmptyCallback;
import com.github.tvbox.osc.callback.LoadingCallback;
import com.github.tvbox.osc.util.AppManager;
import com.kingja.loadsir.callback.Callback;
import com.kingja.loadsir.core.LoadService;
import com.kingja.loadsir.core.LoadSir;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;

import me.jessyan.autosize.AutoSizeConfig;
import me.jessyan.autosize.AutoSizeCompat;
import me.jessyan.autosize.internal.CustomAdapt;
import xyz.doikki.videoplayer.util.CutoutUtil;

/**
 * @author pj567
 * @date :2020/12/17
 * @description:
 */
public abstract class BaseActivity extends AppCompatActivity implements CustomAdapt {
    protected Context mContext;
    private LoadService mLoadService;

    private static float screenRatio = -100.0f;
    private final Runnable refreshAutoSizeRunnable = new Runnable() {
        @Override
        public void run() {
            if (shouldRefreshAutoSize()) {
                refreshAutoSize();
            }
        }
    };
    private final Runnable hideSysBarRunnable = new Runnable() {
        @Override
        public void run() {
            hideSysBar();
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        try {
            if (screenRatio < 0) {
                DisplayMetrics dm = new DisplayMetrics();
                getWindowManager().getDefaultDisplay().getMetrics(dm);
                updateScreenRatio(dm);
            }
        } catch (Throwable th) {
            th.printStackTrace();
        }
        super.onCreate(savedInstanceState);
        setContentView(getLayoutResID());
        mContext = this;
        initSystemUiListener();
        CutoutUtil.adaptCutoutAboveAndroidP(mContext, true);//设置刘海
        applyWindowMode();
        AppManager.getInstance().addActivity(this);
        init();
    }

    /**
     * 是否需要全屏沉浸（隐藏状态栏+导航栏）。
     * 默认 false：普通页面显示系统状态栏，并预留顶部安全区，内容不被信号栏遮挡。
     * 播放类页面覆写返回 true，保持全屏。
     */
    protected boolean needFullscreen() {
        return false;
    }

    /**
     * 统一窗口模式入口。所有 onResume / onWindowFocusChanged / 系统栏监听回调都走这里，
     * 避免"显示状态栏"被 hideSysBar 重新盖上。
     */
    protected void applyWindowMode() {
        if (needFullscreen()) {
            hideSysBar();
        } else {
            showStatusBarWithSafeArea();
        }
    }

    /**
     * 非播放页：显示系统状态栏，透明底色融入主题深蓝紫，并给内容根留 statusBar 高度的安全区。
     * 用 android.R.id.content（DecorView 的内容容器）而不是具体业务布局，通用且不侵入各页面 XML。
     */
    private void showStatusBarWithSafeArea() {
        Window window = getWindow();
        if (window == null) return;
        WindowManager.LayoutParams wlp = window.getAttributes();
        // 主题 android:windowFullscreen=true 会给 Window 加 FLAG_FULLSCREEN，
        // 只清 View 的 SYSTEM_UI_FLAG 状态栏仍不显示，必须清 Window flag。
        wlp.flags &= ~WindowManager.LayoutParams.FLAG_FULLSCREEN;
        window.setAttributes(wlp);
        View decor = window.getDecorView();
        // 清掉全屏标志，状态栏才会真正显示
        int uiOptions = decor.getSystemUiVisibility();
        uiOptions &= ~View.SYSTEM_UI_FLAG_FULLSCREEN;
        uiOptions &= ~View.SYSTEM_UI_FLAG_HIDE_NAVIGATION;
        // 统一用一套机制：保留 LAYOUT_FULLSCREEN，让内容延伸到状态栏下方，
        // 由本方法统一加且只加一次 paddingTop。若清掉此标志，系统会自动避开状态栏
        // （自己加一次 padding），再叠加我们手动的一次就会出现双倍留白。
        uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
        uiOptions &= ~View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        uiOptions &= ~View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        decor.setSystemUiVisibility(uiOptions);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // 用 super.getResources() 绕开本类重写的 AutoSize 逻辑，避免触发回调链
            window.setStatusBarColor(super.getResources().getColor(R.color.pw_bg));
        }
        // 状态栏安全区：把状态栏物理高度作为 content 的顶部 padding，内容从状态栏下方开始。
        // 只设置一次（用 tag 标记），避免 onResume/onFocus 反复调用时重复叠加。
        View content = decor.findViewById(android.R.id.content);
        if (content != null && content.getTag(R.id.pw_statusbar_applied) == null) {
            final int barHeight = getStatusBarHeightPx();
            // 基准 padding 只读取一次：onResume/onFocus 会反复走本方法，靠 tag 保证只设一次，
            // 绝不从"已加过 padding 的 content"再读，避免逐次累加导致顶部越撑越高。
            final int baseLeft = content.getPaddingLeft();
            final int baseRight = content.getPaddingRight();
            final int baseTop = content.getPaddingTop();
            final int baseBottom = content.getPaddingBottom();
            // 顶部安全区只用状态栏物理高度(px)，一次性加足。
            // 不再用 insets.getSystemWindowInsetTop()：部分真机该值经过 AutoSize density
            // 放大，取 max 后会撑出双倍空白（用户反馈的信号栏过高）；固定物理高度最可控。
            // 左右/底部系统栏(insets)不涉及此问题，仍交给系统默认处理，这里只动 top。
            content.setPadding(baseLeft, baseTop + barHeight, baseRight, baseBottom);
            content.setTag(R.id.pw_statusbar_applied, Boolean.TRUE);
        }
    }

    /** 读取系统状态栏高度(物理 px)，不经过 AutoSize density，避免被倍率放大 */
    private int getStatusBarHeightPx() {
        try {
            int id = super.getResources().getIdentifier("status_bar_height", "dimen", "android");
            return id > 0 ? super.getResources().getDimensionPixelSize(id) : 0;
        } catch (Throwable th) {
            return 0;
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 横竖屏切换后，重算屏幕比例并按新方向重新适配尺寸，避免控件错位/错位残留
        try {
            DisplayMetrics dm = new DisplayMetrics();
            getWindowManager().getDefaultDisplay().getMetrics(dm);
            updateScreenRatio(dm);
            AutoSizeCompat.autoConvertDensityOfCustomAdapt(super.getResources(), this);
            View decorView = getWindow().getDecorView();
            if (decorView != null) decorView.requestLayout();
        } catch (Throwable th) {
            th.printStackTrace();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyWindowMode();
        changeWallpaper(false);
        if (shouldRefreshAutoSize()) {
            refreshAutoSize();
            scheduleRefreshAutoSize();
        }
    }

    public void hideSysBar() {
        // 播放页需要真全屏：恢复 Window 的 FLAG_FULLSCREEN（普通页会清掉）
        Window window = getWindow();
        if (window != null) {
            WindowManager.LayoutParams wlp = window.getAttributes();
            wlp.flags |= WindowManager.LayoutParams.FLAG_FULLSCREEN;
            window.setAttributes(wlp);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            int uiOptions = getWindow().getDecorView().getSystemUiVisibility();
            uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
            uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
            uiOptions |= View.SYSTEM_UI_FLAG_HIDE_NAVIGATION;
            uiOptions |= View.SYSTEM_UI_FLAG_FULLSCREEN;
            uiOptions |= View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            getWindow().getDecorView().setSystemUiVisibility(uiOptions);
        }
    }

    private void initSystemUiListener() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            final View decorView = getWindow().getDecorView();
            decorView.setOnSystemUiVisibilityChangeListener(new View.OnSystemUiVisibilityChangeListener() {
                @Override
                public void onSystemUiVisibilityChange(int visibility) {
                    // 仅全屏页需要在系统栏被唤出后重新隐藏；普通页保持状态栏显示，不做处理
                    if (needFullscreen()) {
                        int hiddenBars = View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN;
                        if ((visibility & hiddenBars) != hiddenBars) {
                            decorView.removeCallbacks(hideSysBarRunnable);
                            decorView.postDelayed(hideSysBarRunnable, 300);
                        }
                    }
                }
            });
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        getWindow().getDecorView().removeCallbacks(refreshAutoSizeRunnable);
        getWindow().getDecorView().removeCallbacks(hideSysBarRunnable);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyWindowMode();
            if (shouldRefreshAutoSize()) {
                scheduleRefreshAutoSize();
            }
        }
    }

    protected boolean shouldRefreshAutoSize() {
        return false;
    }

    private void scheduleRefreshAutoSize() {
        View decorView = getWindow().getDecorView();
        decorView.removeCallbacks(refreshAutoSizeRunnable);
        decorView.postDelayed(refreshAutoSizeRunnable, 300);
    }

    private void refreshAutoSize() {
        try {
            DisplayMetrics dm = new DisplayMetrics();
            getWindowManager().getDefaultDisplay().getMetrics(dm);
            if (dm.widthPixels <= 0 || dm.heightPixels <= 0) {
                return;
            }
            updateScreenRatio(dm);
            AutoSizeConfig.getInstance()
                    .setScreenWidth(dm.widthPixels)
                    .setScreenHeight(dm.heightPixels);
            AutoSizeCompat.autoConvertDensityOfCustomAdapt(super.getResources(), this);
            getWindow().getDecorView().requestLayout();
        } catch (Throwable th) {
            th.printStackTrace();
        }
    }

    private void updateScreenRatio(DisplayMetrics dm) {
        int screenWidth = dm.widthPixels;
        int screenHeight = dm.heightPixels;
        int min = Math.min(screenWidth, screenHeight);
        if (min > 0) {
            screenRatio = (float) Math.max(screenWidth, screenHeight) / (float) min;
        }
    }

    @Override
    public Resources getResources() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            AutoSizeCompat.autoConvertDensityOfCustomAdapt(super.getResources(), this);
        }
        return super.getResources();
    }

    public boolean hasPermission(String permission) {
        boolean has = true;
        try {
            has = PermissionChecker.checkSelfPermission(this, permission) == PermissionChecker.PERMISSION_GRANTED;
        } catch (Exception e) {
            e.printStackTrace();
        }
        return has;
    }

    protected abstract int getLayoutResID();

    protected abstract void init();

    protected void setLoadSir(View view) {
        if (mLoadService == null) {
            mLoadService = LoadSir.getDefault().register(view, new Callback.OnReloadListener() {
                @Override
                public void onReload(View v) {
                }
            });
        }
    }

    protected void showLoading() {
        if (mLoadService != null) {
            mLoadService.showCallback(LoadingCallback.class);
        }
    }

    protected boolean isLoading() {
        if (mLoadService != null && mLoadService.getCurrentCallback() != null) {
            return mLoadService.getCurrentCallback().equals(LoadingCallback.class);
        }
        return false;
    }

    protected void showEmpty() {
        if (null != mLoadService) {
            mLoadService.showCallback(EmptyCallback.class);
        }
    }

    protected void showSuccess() {
        if (null != mLoadService) {
            mLoadService.showSuccess();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        AppManager.getInstance().finishActivity(this);
    }

    public void jumpActivity(Class<? extends BaseActivity> clazz) {
        Intent intent = new Intent(mContext, clazz);
        startActivity(intent);
    }

    public void jumpActivity(Class<? extends BaseActivity> clazz, Bundle bundle) {
        Intent intent = new Intent(mContext, clazz);
        intent.putExtras(bundle);
        startActivity(intent);
    }

    protected String getAssetText(String fileName) {
        StringBuilder stringBuilder = new StringBuilder();
        try {
            AssetManager assets = getAssets();
            BufferedReader bf = new BufferedReader(new InputStreamReader(assets.open(fileName)));
            String line;
            while ((line = bf.readLine()) != null) {
                stringBuilder.append(line);
            }
            return stringBuilder.toString();
        } catch (IOException e) {
            e.printStackTrace();
        }
        return "";
    }

    /** 当前是否为竖屏（响应横竖屏切换的核心判定） */
    public boolean isPortrait() {
        // 关键：必须用 super.getResources()，不能调用 getResources()。
        // 本类重写了 getResources()，其中会触发 AutoSize 回调 isBaseOnWidth()/getSizeInDp()，
        // 而这两个方法又会调用 isPortrait()——若此处再调用 getResources() 将形成无限递归，
        // 导致 StackOverflowError 启动闪退。super.getResources() 绕过重写，取原始 Resources。
        try {
            return super.getResources().getConfiguration().orientation == Configuration.ORIENTATION_PORTRAIT;
        } catch (Throwable th) {
            return false;
        }
    }

    @Override
    public float getSizeInDp() {
        // 横竖屏统一按宽度 1280 基准适配（超宽屏除外），保证布局等比缩放不裁切
        return isBaseOnWidth() ? 1280 : 720;
    }

    @Override
    public boolean isBaseOnWidth() {
        // 设计基准 1280×720 是横屏尺寸。竖屏必须同样按"宽度"适配：
        // 若竖屏按高度 720 基准，density 会被放大数倍，布局设计宽度 1280dp
        // 换算后远超屏幕实际宽度，导致所有控件横向溢出被裁切（竖屏错乱的根因）。
        // 竖屏 screenRatio≈2（<4），原判断天然返回 true（按宽度），符合预期。
        // 超宽屏（ratio>=4）仍按高度，保持原逻辑。
        return !(screenRatio >= 4.0f);
    }

    /** 网格列数：横屏沿用原 5/6 列；竖屏 3 列 + 放大卡片（配合 values-port/dimens.xml），更好看 */
    public int gridSpanCount() {
        if (isPortrait()) return 3;
        return isBaseOnWidth() ? 5 : 6;
    }

    protected static BitmapDrawable globalWp = null;

    public void changeWallpaper(boolean force) {
        if (!force && globalWp != null)
            getWindow().setBackgroundDrawable(globalWp);
        try {
            File wp = new File(getFilesDir().getAbsolutePath() + "/wp");
            if (wp.exists()) {
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(wp.getAbsolutePath(), opts);
                // 从Options中获取图片的分辨率
                int imageHeight = opts.outHeight;
                int imageWidth = opts.outWidth;
                int picHeight = 720;
                int picWidth = 1080;
                int scaleX = imageWidth / picWidth;
                int scaleY = imageHeight / picHeight;
                int scale = 1;
                if (scaleX > scaleY && scaleY >= 1) {
                    scale = scaleX;
                }
                if (scaleX < scaleY && scaleX >= 1) {
                    scale = scaleY;
                }
                opts.inJustDecodeBounds = false;
                // 采样率
                opts.inSampleSize = scale;
                globalWp = new BitmapDrawable(BitmapFactory.decodeFile(wp.getAbsolutePath(), opts));
            } else {
                globalWp = null;
            }
        } catch (Throwable throwable) {
            throwable.printStackTrace();
            globalWp = null;
        }
        if (globalWp != null)
            getWindow().setBackgroundDrawable(globalWp);
        else
            getWindow().setBackgroundDrawableResource(R.drawable.pc_bg);
    }
}