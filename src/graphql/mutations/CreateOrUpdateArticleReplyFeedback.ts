import { GraphQLString, GraphQLNonNull } from 'graphql';

import { assertUser, getContentDefaultStatus } from 'util/user';
import FeedbackVote from 'graphql/models/FeedbackVote';
import ArticleReply from 'graphql/models/ArticleReply';

import type {
  Article,
  ArticleReply as ArticleReplyType,
} from 'rumors-db/schema/articles';
import type { ArticleReplyFeedback } from 'rumors-db/schema/articlereplyfeedbacks';
import type { Reply } from 'rumors-db/schema/replies';

import client from 'util/client';
import { ResolverContext } from 'contextFactory';

export function getArticleReplyFeedbackId({
  articleId,
  replyId,
  userId,
  appId,
}: {
  articleId: string;
  replyId: string;
  userId: string;
  appId: string;
}) {
  return `${articleId}__${replyId}__${userId}__${appId}`;
}

/**
 * Updates the positive and negative feedback count of the article reply with
 * specified `articleId` and `replyId`.
 *
 * @returns The updated article reply
 */
export async function updateArticleReplyByFeedbacks(
  articleId: string,
  replyId: string,
  feedbacks: ArticleReplyFeedback[]
): Promise<ArticleReplyType> {
  const [positiveFeedbackCount, negativeFeedbackCount] = feedbacks
    .filter(({ status }) => status === 'NORMAL')
    .reduce(
      (agg, { score }) => {
        if (score === 1) {
          agg[0] += 1;
        } else if (score === -1) {
          agg[1] += 1;
        }
        return agg;
      },
      [0, 0]
    );

  const { body: articleReplyUpdateResult } = await client.update({
    index: 'articles',
    type: 'doc',
    id: articleId,
    body: {
      script: {
        source: `
          int idx = 0;
          int replyCount = ctx._source.articleReplies.size();
          for(; idx < replyCount; idx += 1) {
            HashMap articleReply = ctx._source.articleReplies.get(idx);
            if( articleReply.get('replyId').equals(params.replyId) ) {
              break;
            }
          }

          if( idx === replyCount ) {
            ctx.op = 'none';
          } else {
            ctx._source.articleReplies.get(idx).put(
              'positiveFeedbackCount', params.positiveFeedbackCount);
            ctx._source.articleReplies.get(idx).put(
              'negativeFeedbackCount', params.negativeFeedbackCount);
          }
        `,
        params: {
          replyId,
          positiveFeedbackCount,
          negativeFeedbackCount,
        },
      },
    },
    _source: 'true',
  });

  /* istanbul ignore if */
  if (articleReplyUpdateResult.result !== 'updated') {
    throw new Error(`Cannot article ${articleId}'s feedback count`);
  }

  return articleReplyUpdateResult.get._source.articleReplies.find(
    (articleReply: ArticleReplyType) => articleReply.replyId === replyId
  );
}

export default {
  description: 'Create or update a feedback on an article-reply connection',
  type: ArticleReply,
  args: {
    articleId: { type: new GraphQLNonNull(GraphQLString) },
    replyId: { type: new GraphQLNonNull(GraphQLString) },
    vote: { type: new GraphQLNonNull(FeedbackVote) },
    comment: { type: GraphQLString },
  },
  async resolve(
    rootValue: unknown,
    {
      articleId,
      replyId,
      vote,
      comment,
    }: {
      articleId: string;
      replyId: string;
      vote: 1 | 0 | -1;
      comment?: string | null;
    },
    { user, loaders }: ResolverContext
  ) {
    assertUser(user);

    const now = new Date().toISOString();

    // (articleId, replyId, userId, appId) should be unique
    // but user can update
    const id = getArticleReplyFeedbackId({
      articleId,
      replyId,
      userId: user.id,
      appId: user.appId,
    });

    const {
      body: { result },
    } = await client.update({
      index: 'articlereplyfeedbacks',
      type: 'doc',
      id,
      body: {
        doc: {
          score: vote,
          comment: comment,
          updatedAt: now,
        },
        upsert: {
          articleId,
          replyId,
          userId: user.id,
          appId: user.appId,
          score: vote,
          createdAt: now,
          updatedAt: now,
          comment: comment,
          status: getContentDefaultStatus(user),
        },
      },
      refresh: 'true', // We are searching for articlereplyfeedbacks immediately
    });

    if (result === 'created') {
      // Fill in reply & article reply author ID
      //

      const [{ userId: replyUserId }, article] =
        (await loaders.docLoader.loadMany([
          {
            index: 'replies',
            id: replyId,
          },
          {
            index: 'articles',
            id: articleId,
          },
        ])) as [Reply, Article];

      const ar = article.articleReplies.find((ar) => ar.replyId === replyId);

      // Make typescript happy
      if (!ar) {
        throw new Error(
          `Cannot find article-reply with article ID = ${articleId} and reply ID = ${replyId}`
        );
      }

      const { userId: articleReplyUserId } = ar;

      await client.update({
        index: 'articlereplyfeedbacks',
        type: 'doc',
        id,
        body: {
          doc: {
            replyUserId,
            articleReplyUserId,
          },
        },
      });
    }

    const feedbacks = await loaders.articleReplyFeedbacksLoader.load({
      articleId,
      replyId,
    });

    const updatedArticleReply = await updateArticleReplyByFeedbacks(
      articleId,
      replyId,
      feedbacks
    );

    /* istanbul ignore if */
    if (!updatedArticleReply) {
      throw new Error(
        `Cannot get updated article reply with article ID = ${articleId} and reply ID = ${replyId}`
      );
    }

    return { articleId, ...updatedArticleReply };
  },
};
