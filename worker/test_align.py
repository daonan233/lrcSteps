import unittest

import numpy as np

from align import SudachiReading, forced_ctc, japanese_target, roman_target, units_from_centers


class AlignmentTests(unittest.TestCase):
    def test_ctc_trellis_keeps_letter_order(self):
        probabilities = np.full((8, 4), 0.01)
        for frame, token in enumerate([0, 1, 0, 2, 0, 3, 0, 0]):
            probabilities[frame, token] = 0.97
        centers, score = forced_ctc(np.log(probabilities), [1, 2, 3], 0)
        self.assertEqual(centers, [1, 3, 5])
        self.assertGreater(score, 0.9)

    def test_roman_mapping_preserves_spaces(self):
        target, spans = roman_target('kimi ga')
        self.assertEqual(target, 'kimiga')
        self.assertEqual(spans[4], (4, 4))
        units = units_from_centers('kimi ga', spans, list(range(6)), 0, 3, 6, 0, 3)
        self.assertEqual(''.join(unit['text'] for unit in units), 'kimi ga')

    def test_japanese_reading_maps_to_original_glyphs(self):
        from pykakasi import kakasi
        target, spans = japanese_target('世界が', SudachiReading(kakasi()))
        self.assertEqual(target, 'sekaiga')
        self.assertEqual(len(spans), 3)


if __name__ == '__main__':
    unittest.main()
