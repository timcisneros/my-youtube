interface ChannelBrowseInfo {
  channelId: string;
  title: string;
  thumbnail: string;
}

interface ThumbnailSource {
  url?: string;
}

interface ChannelBrowsePayload {
  metadata?: {
    channelMetadataRenderer?: {
      title?: string;
      avatar?: { thumbnails?: ThumbnailSource[] };
    };
  };
  header?: {
    pageHeaderRenderer?: {
      content?: {
        pageHeaderViewModel?: {
          title?: {
            dynamicTextViewModel?: { text?: { content?: string } };
            text?: string;
          };
          pageTitle?: string;
          image?: {
            decoratedAvatarViewModel?: {
              avatar?: {
                avatarViewModel?: { image?: { sources?: ThumbnailSource[] } };
              };
            };
          };
        };
      };
    };
    c4TabbedHeaderRenderer?: {
      title?: string;
      avatar?: { thumbnails?: ThumbnailSource[] };
    };
  };
}

function parseChannelBrowseMetadata(data: unknown, channelId: string): ChannelBrowseInfo | null {
  const browse = data as ChannelBrowsePayload | null;
  const metadata = browse?.metadata?.channelMetadataRenderer;
  const pageHeader = browse?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
  const legacyHeader = browse?.header?.c4TabbedHeaderRenderer;
  const pageHeaderTitle = pageHeader?.title?.dynamicTextViewModel?.text?.content
    || pageHeader?.title?.text
    || pageHeader?.pageTitle;
  const metadataThumbnails = metadata?.avatar?.thumbnails || [];
  const pageHeaderSources = pageHeader?.image?.decoratedAvatarViewModel?.avatar
    ?.avatarViewModel?.image?.sources || [];
  const legacyThumbnails = legacyHeader?.avatar?.thumbnails || [];
  const title = metadata?.title || pageHeaderTitle || legacyHeader?.title || '';
  const thumbnail = metadataThumbnails.at(-1)?.url
    || pageHeaderSources.at(-1)?.url
    || legacyThumbnails.at(-1)?.url
    || '';
  if (!title && !thumbnail) return null;
  return { channelId, title, thumbnail };
}

export { parseChannelBrowseMetadata };
export type { ChannelBrowseInfo };
