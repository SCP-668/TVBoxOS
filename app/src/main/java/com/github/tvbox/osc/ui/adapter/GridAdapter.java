package com.github.tvbox.osc.ui.adapter;

import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;

import com.chad.library.adapter.base.BaseQuickAdapter;
import com.chad.library.adapter.base.BaseViewHolder;
import com.github.tvbox.osc.R;
import com.github.tvbox.osc.bean.Movie;
import com.github.tvbox.osc.util.ImgUtil;

import java.util.ArrayList;

import me.jessyan.autosize.utils.AutoSizeUtils;

public class GridAdapter extends BaseQuickAdapter<Movie.Video, BaseViewHolder> {
    private boolean mShowList;
    private int defaultWidth;
    public ImgUtil.Style style;

    /** 卡片尺寸由 GridFragment 按网格实测列宽写入，避免 mm 写死导致卡片过小、列不居中 */
    private int cardW = 0;
    private int cardH = 0;

    public void setMetrics(int cardW, int cardH) {
        this.cardW = cardW;
        this.cardH = cardH;
    }

    public GridAdapter(boolean showList, ImgUtil.Style style) {
        super(showList ? R.layout.item_list : R.layout.item_grid, new ArrayList<>());
        this.mShowList = showList;
        if (style != null) {
            if (style.type.equals("list")) this.mShowList = true;
            this.defaultWidth = ImgUtil.getStyleDefaultWidth(style);
        }
        this.style = style;
    }

    @Override
    protected void convert(BaseViewHolder helper, Movie.Video item) {
        if (this.mShowList) {
            helper.setText(R.id.tvNote, item.note);
            helper.setText(R.id.tvName, item.name);
            ImageView ivThumb = helper.getView(R.id.ivThumb);
            String pic = item.pic == null ? "" : item.pic.trim();
            if (!TextUtils.isEmpty(pic)) {
                if (ImgUtil.isBase64Image(pic)) {
                    ivThumb.setImageBitmap(ImgUtil.decodeBase64ToBitmap(pic));
                } else {
                    int roundingRadius = AutoSizeUtils.mm2px(mContext, 10);
                    int imageWidth = AutoSizeUtils.mm2px(mContext, 240);
                    int imageHeight = AutoSizeUtils.mm2px(mContext, 336);
                    if (style != null) {
                        ImgUtil.load(pic, ivThumb, roundingRadius, imageWidth, imageHeight, item.name, ImageView.ScaleType.FIT_XY);
                    } else {
                        ImgUtil.load(pic, ivThumb, roundingRadius, imageWidth, imageHeight, item.name);
                    }
                }
            } else {
                ivThumb.setImageDrawable(ImgUtil.createTextDrawable(item.name));
            }
            return;
        }

        TextView tvYear = helper.getView(R.id.tvYear);
        if (item.year <= 0) {
            tvYear.setVisibility(View.GONE);
        } else {
            tvYear.setText(String.valueOf(item.year));
            tvYear.setVisibility(View.VISIBLE);
        }
        TextView tvLang = helper.getView(R.id.tvLang);
        tvLang.setVisibility(View.GONE);
        TextView tvArea = helper.getView(R.id.tvArea);
        tvArea.setVisibility(View.GONE);
        if (TextUtils.isEmpty(item.note)) {
            helper.setVisible(R.id.tvNote, false);
        } else {
            helper.setVisible(R.id.tvNote, true);
            helper.setText(R.id.tvNote, item.note);
        }
        helper.setText(R.id.tvName, item.name);
        helper.setText(R.id.tvActor, item.actor);
        ImageView ivThumb = helper.getView(R.id.ivThumb);
        int newWidth = cardW > 0 ? cardW : AutoSizeUtils.mm2px(mContext, ImgUtil.defaultWidth);
        int newHeight = cardH > 0 ? cardH : AutoSizeUtils.mm2px(mContext, ImgUtil.defaultHeight);
        String pic = item.pic == null ? "" : item.pic.trim();
        if (!TextUtils.isEmpty(pic)) {
            if (ImgUtil.isBase64Image(pic)) {
                ivThumb.setImageBitmap(ImgUtil.decodeBase64ToBitmap(pic));
            } else {
                int roundingRadius = AutoSizeUtils.mm2px(mContext, 10);
                int imageWidth = newWidth;
                int imageHeight = newHeight;
                if (style != null) {
                    ImgUtil.load(pic, ivThumb, roundingRadius, imageWidth, imageHeight, item.name, ImageView.ScaleType.FIT_XY);
                } else {
                    ImgUtil.load(pic, ivThumb, roundingRadius, imageWidth, imageHeight, item.name);
                }
            }
        } else {
            ivThumb.setImageDrawable(ImgUtil.createTextDrawable(item.name));
        }
        applyStyleToImage(helper, ivThumb);
    }

    private void applyStyleToImage(BaseViewHolder helper, final ImageView ivThumb) {
        // 卡片宽度必须等于网格列宽，否则 GridLayoutManager 按列均分、item 却固定更窄，
        // 会出现列间巨大空隙且整体不居中（用户反馈"类型列表不居中、卡片太小"）。
        if (cardW <= 0 || cardH <= 0) return;
        View itemView = helper.itemView;
        ViewGroup.LayoutParams ilp = itemView.getLayoutParams();
        if (ilp != null) {
            ilp.width = cardW;
            ilp.height = ViewGroup.LayoutParams.WRAP_CONTENT;
            itemView.setLayoutParams(ilp);
        }
        ViewGroup container = (ViewGroup) ivThumb.getParent();
        ViewGroup.LayoutParams containerParams = container.getLayoutParams();
        containerParams.width = ViewGroup.LayoutParams.MATCH_PARENT;
        containerParams.height = cardH;
        container.setLayoutParams(containerParams);
    }
}
