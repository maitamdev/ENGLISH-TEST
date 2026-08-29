export type LearningSourceKey = "tatoeba-en-vi" | "cmudict" | "meta-covost" | "authorized-facebook-page";

export type LearningSourceDefinition = {
  key: LearningSourceKey;
  displayName: string;
  provider: string;
  homepageUrl: string;
  dataUrl: string | null;
  licenseId: string;
  licenseUrl: string;
  attributionText: string;
  sourceKind: "open_dataset" | "open_source_project" | "authorized_facebook_page";
};
// This catalog is configuration, not learning seed data. Every imported row is
// fetched from its upstream source and persisted with record-level provenance.
export const LEARNING_SOURCE_CATALOG: Record<LearningSourceKey, LearningSourceDefinition> = {
  "tatoeba-en-vi": {
    key: "tatoeba-en-vi",
    displayName: "Tatoeba English and Vietnamese",
    provider: "Tatoeba Association",
    homepageUrl: "https://tatoeba.org",
    dataUrl: "https://api.tatoeba.org/v1/sentences",
    licenseId: "CC BY 2.0 FR or CC0 1.0 per record",
    licenseUrl: "https://tatoeba.org/en/downloads",
    attributionText: "Sentence data from Tatoeba. Record owners and licenses are retained with every imported pair.",
    sourceKind: "open_dataset"
  },
  cmudict: {
    key: "cmudict",
    displayName: "CMU Pronouncing Dictionary",
    provider: "Carnegie Mellon University",
    homepageUrl: "https://github.com/cmusphinx/cmudict",
    dataUrl: "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict",
    licenseId: "CMU 2-clause BSD-style license",
    licenseUrl: "https://github.com/cmusphinx/cmudict/blob/master/LICENSE",
    attributionText: "Copyright 1993-2015 Carnegie Mellon University. CMUdict contributors are acknowledged under the upstream license.",
    sourceKind: "open_source_project"
  },
  "meta-covost": {
    key: "meta-covost",
    displayName: "Meta AI CoVoST 2",
    provider: "Meta AI Research",
    homepageUrl: "https://ai.meta.com/tools/covost/",
    dataUrl: "https://github.com/facebookresearch/covost",
    licenseId: "CC0 1.0",
    licenseUrl: "https://github.com/facebookresearch/covost",
    attributionText: "CoVoST was released by Meta AI Research under CC0 and is based on Mozilla Common Voice.",
    sourceKind: "open_dataset"
  },
  "authorized-facebook-page": {
    key: "authorized-facebook-page",
    displayName: "Authorized Facebook Page",
    provider: "Meta Graph API",
    homepageUrl: "https://developers.facebook.com/docs/graph-api/",
    dataUrl: null,
    licenseId: "Rights-holder authorization required",
    licenseUrl: "https://www.facebook.com/legal/terms",
    attributionText: "Content imported only from a Page controlled by the deployer with documented reuse permission.",
    sourceKind: "authorized_facebook_page"
  }
};
