import { useRef } from "react";
import { t } from "../lib/i18n";
import { Fold } from "./Fold";

const REPO = "https://github.com/HK-SHAO/atools";

export function About() {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button type="button" className="head-btn" onClick={() => ref.current?.showModal()}>
        {t("about")}
      </button>
      <dialog
        ref={ref}
        className="about"
        aria-labelledby="about-title"
        onClick={e => {
          // Clicking the backdrop closes. Title, body, and footer fill the content box,
          // so this only fires on a hit outside them.
          if (e.target === ref.current) ref.current.close();
        }}
      >
        <h2 id="about-title">{t("aboutTitle")}</h2>
        <div className="about-body">
          <p>{t("aboutLead1")}</p>
          <p>{t("aboutLead2")}</p>
          <p>{t("aboutLead3")}</p>

          <Fold label={t("aboutTech")}>
            <p>{t("aboutKernel")}</p>
            <p>{t("aboutUi")}</p>
            <p>{t("aboutCore")}</p>
          </Fold>

          <Fold label={t("aboutMeasured")}>
            <p>{t("aboutSpeed")}</p>
            <p>{t("aboutError")}</p>
          </Fold>
        </div>

        <form method="dialog" className="about-foot">
          <a href={REPO} target="_blank" rel="noreferrer">
            {t("source")}
          </a>
          <button type="submit" className="act">
            {t("close")}
          </button>
        </form>
      </dialog>
    </>
  );
}
