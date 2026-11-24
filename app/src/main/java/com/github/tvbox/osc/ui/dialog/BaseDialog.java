package com.github.tvbox.osc.ui.dialog;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import androidx.annotation.NonNull;

import com.github.tvbox.osc.R;

import xyz.doikki.videoplayer.util.CutoutUtil;

public class BaseDialog extends Dialog {
    public BaseDialog(@NonNull Context context) {
        super(context, R.style.CustomDialogStyle);
    }

    public BaseDialog(Context context, int customDialogStyle) {
        super(context, customDialogStyle);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        CutoutUtil.adaptCutoutAboveAndroidP(this, true);//设置刘海
        super.onCreate(savedInstanceState);
    }

    @Override
    public void show() {
        if (isContextInvalid()) {
            return;
        }
        Window window = getWindow();
        if (window == null) {
            super.show();
            return;
        }
        window.setFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        super.show();
        applyStatusBarMode(window);
        window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
    }

    private boolean isContextInvalid() {
        Context context = getContext();
        if (!(context instanceof Activity)) {
            return false;
        }
        Activity activity = (Activity) context;
        return activity.isFinishing()
                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && activity.isDestroyed());
    }

    /**
     * 弹窗不能一律隐藏状态栏：普通页面上打开筛选/选集等弹窗时，信号栏应继续保持可见。
     * 只有宿主本来就是全屏播放页时，弹窗才沿用全屏沉浸，避免播放器被状态栏打断。
     */
    private void applyStatusBarMode(Window window) {
        boolean hostFullscreen = false;
        Context context = getContext();
        if (context instanceof Activity) {
            Window hostWindow = ((Activity) context).getWindow();
            if (hostWindow != null) {
                hostFullscreen = (hostWindow.getDecorView().getSystemUiVisibility()
                        & View.SYSTEM_UI_FLAG_FULLSCREEN) != 0;
            }
        }
        WindowManager.LayoutParams lp = window.getAttributes();
        if (hostFullscreen) {
            lp.flags |= WindowManager.LayoutParams.FLAG_FULLSCREEN;
        } else {
            lp.flags &= ~WindowManager.LayoutParams.FLAG_FULLSCREEN;
        }
        window.setAttributes(lp);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            int uiOptions = window.getDecorView().getSystemUiVisibility();
            if (hostFullscreen) {
                uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
                uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
                uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
                uiOptions |= View.SYSTEM_UI_FLAG_HIDE_NAVIGATION;
                uiOptions |= View.SYSTEM_UI_FLAG_FULLSCREEN;
                uiOptions |= View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            } else {
                uiOptions &= ~View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
                uiOptions &= ~View.SYSTEM_UI_FLAG_HIDE_NAVIGATION;
                uiOptions &= ~View.SYSTEM_UI_FLAG_FULLSCREEN;
                uiOptions &= ~View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            }
            window.getDecorView().setSystemUiVisibility(uiOptions);
        }
    }
}
