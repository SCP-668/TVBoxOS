package com.github.tvbox.osc.ui.widget.motion;

/**
 * 动效总开关。每项独立可控，线上若某项表现异常可单独关闭，
 * 不影响功能与其余动效，满足「可回退」要求。
 */
public final class MotionConfig {
    public static boolean PRESS_REBOUND = true;
    public static boolean TOUCH_RIPPLE = true;
    public static boolean SKELETON = true;
    public static boolean SECTION_DRAWER = true;

    private MotionConfig() {
    }
}
