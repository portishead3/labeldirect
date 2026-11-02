from bot.fedex import DocExtract, same_label_details


def label(**kwargs):
    return DocExtract(kind="label", **kwargs)


def test_a_second_label_with_the_same_details_is_not_an_edit():
    stored = label(
        recipient_lines=["Philip More", "3 Southwark Street", "SE1 1RQ"],
        recipient_country="GB",
        weight_kg=0.454,
        tracking_candidates=["879510763975"],
    )
    again = label(
        recipient_lines=["Philip Moré", "3 southwark street", "SE11RQ"],
        recipient_country="GB",
        weight_kg=0.45,
        tracking_candidates=["879525861430"],
    )
    assert same_label_details(stored, again) is True


def test_a_label_with_changed_details_is_an_edit():
    stored = label(recipient_lines=["Philip More", "3 Southwark Street"], weight_kg=0.454)
    edited = label(recipient_lines=["Richard Benderson", "36 The Drive"], weight_kg=0.454)
    heavier = label(recipient_lines=["Philip More", "3 Southwark Street"], weight_kg=2.0)
    assert same_label_details(stored, edited) is False
    assert same_label_details(stored, heavier) is False
