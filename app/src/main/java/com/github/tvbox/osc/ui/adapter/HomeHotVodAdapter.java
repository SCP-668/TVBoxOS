package com.github.tvbox.osc.ui.adapter;

import android.text.TextUtils;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

import com.chad.library.adapter.base.BaseQuickAdapter;
import com.chad.library.adapter.base.BaseViewHolder;
import com.github.tvbox.osc.R;
import com.github.tvbox.osc.api.ApiConfig;
import com.github.tvbox.osc.bean.Movie;
import com.github.tvbox.osc.bean.SourceBean;
import com.github.tvbox.osc.util.HawkConfig;
import com.github.tvbox.osc.util.ImgUtil;
import com.orhanobut.hawk.Hawk;

import java.util.ArrayList;

import me.jessyan.autosize.utils.AutoSizeUtils;

public class HomeHotVodAdapter extends BaseQuickAdapter<Movie.Video, BaseViewHolder> {
    private int defaultWidth;
    private final ImgUtil.Style style;
    private String tvRateValue;

    /** 由 UserFragment.applyResponsiveLayout() 写入：卡片尺寸全部按当前屏幕像素算 */
    private boolean portraitGrid = false;
    private int cardW = 0;
    private int cardH = 0;
    private int shortSide = 0;

    public HomeHotVodAdapter(ImgUtil.Style style, String tvRate) {
        super(R.layout.item_user_hot_vod, new ArrayList<>());
        if (style != null) {
            this.defaultWidth = ImgUtil.getStyleDefaultWidth(style);
        }
        this.style = style;
        this.tvRateValue = tvRate;
    }

    public void setMetrics(boolean portraitGrid, int cardW, int cardH, int shortSide) {
        this.portraitGrid = portraitGrid;
        this.cardW = cardW;
        this.cardH = cardH;
        this.shortSide = shortSide;
    }

    @Override
    protected void convert(BaseViewHolder helper, Movie.Video item) {
        FrameLayout tvDel = helper.getView(R.id.delFrameLayout);
        tvDel.setVisibility(HawkConfig.hotVodDelete ? View.VISIBLE : View.GONE);

        TextView tvRate = helper.getView(R.id.tvRate);
        if (Hawk.get(HawkConfig.HOME_REC, HawkConfig.DEFAULT_HOME_REC) == 2) {
            SourceBean bean = ApiConfig.get().getSource(item.sourceKey);
            tvRateValue = bean != null ? bean.getName() : "";
        }
        tvRate.setText(tvRateValue);

        TextView tvNote = helper.getView(R.id.tvNote);
        if (item.note == null || item.note.isEmpty()) {
            tvNote.setVisibility(View.GONE);
        } else {
            tvNote.setText(item.note);
            tvNote.setVisibility(View.VISIBLE);
        }
        TextView tvName = helper.getView(R.id.tvName);
        tvName.setText(item.name);

        int textBase = shortSide > 0 ? shortSide : Math.min(
                mContext.getResources().getDisplayMetrics().widthPixels,
                mContext.getResources().getDisplayMetrics().heightPixels);
        int nameSize = Math.round(textBase * 0.021f);
        int captionSize = Math.round(textBase * 0.017f);
        tvName.setTextSize(TypedValue.COMPLEX_UNIT_PX, nameSize);
        tvNote.setTextSize(TypedValue.COMPLEX_UNIT_PX, captionSize);
        tvRate.setTextSize(TypedValue.COMPLEX_UNIT_PX, captionSize);

        ImageView ivThumb = helper.getView(R.id.ivThumb);
        int loadW = cardW > 0 ? cardW : AutoSizeUtils.mm2px(mContext, ImgUtil.defaultWidth);
        int loadH = cardH > 0 ? cardH : AutoSizeUtils.mm2px(mContext, ImgUtil.defaultHeight);

        String pic = item.pic == null ? "" : item.pic.trim();
        if (!TextUtils.isEmpty(pic)) {
            if (ImgUtil.isBase64Image(pic)) {
                ivThumb.setImageBitmap(ImgUtil.decodeBase64ToBitmap(pic));
            } else {
                ImgUtil.load(pic, ivThumb, AutoSizeUtils.mm2px(mContext, 10), loadW, loadH, item.name);
            }
        } else {
            ivThumb.setImageDrawable(ImgUtil.createTextDrawable(item.name));
        }
        applyCardSize(helper);
    }

    /**
     * 卡片尺寸：竖屏 = 两列网格的列宽；横屏 = 一行横滑，高度吃满列表、按海报比例算宽。
     * 宽度必须固定（横滑时若 match_parent 会导致一个 item 占满整行、列表滚不动）。
     */
    private void applyCardSize(BaseViewHolder helper) {
        if (cardW <= 0 || cardH <= 0) return;
        View itemView = helper.itemView;
        View frame = itemView.findViewById(R.id.mItemFrame);
        int pad = Math.max(1, Math.round(shortSide * 0.004f));
        itemView.setPadding(pad, pad, pad, pad);
        ViewGroup.LayoutParams ilp = itemView.getLayoutParams();
        if (ilp != null) {
            ilp.width = portraitGrid ? ViewGroup.LayoutParams.MATCH_PARENT : cardW;
            ilp.height = ViewGroup.LayoutParams.WRAP_CONTENT;
            itemView.setLayoutParams(ilp);
        }
        if (frame != null) {
            ViewGroup.LayoutParams flp = frame.getLayoutParams();
            flp.width = ViewGroup.LayoutParams.MATCH_PARENT;
            flp.height = cardH;
            frame.setLayoutParams(flp);
        }
    }
}