import unittest

import numpy as np

from align import SudachiReading, anchored_line_end, forced_ctc, japanese_target, load_pretrained, phoneme_times, reading_indices, roman_target, subsequence_indices, units_from_centers


class AlignmentTests(unittest.TestCase):
    def test_cached_model_is_loaded_without_network_probe(self):
        class CachedComponent:
            calls = []

            @classmethod
            def from_pretrained(cls, name, **kwargs):
                cls.calls.append(kwargs)
                return name

        self.assertEqual(load_pretrained(CachedComponent, 'cached-model'), 'cached-model')
        self.assertEqual(CachedComponent.calls, [{'local_files_only': True}])

    def test_missing_cache_falls_back_to_download(self):
        class UncachedComponent:
            calls = []

            @classmethod
            def from_pretrained(cls, name, **kwargs):
                cls.calls.append(kwargs)
                if kwargs.get('local_files_only'):
                    raise OSError('not cached')
                return name

        self.assertEqual(load_pretrained(UncachedComponent, 'new-model'), 'new-model')
        self.assertEqual(UncachedComponent.calls, [{'local_files_only': True}, {}])

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

    def test_japanese_spaces_and_punctuation_do_not_become_spoken_words(self):
        from pykakasi import kakasi
        target, spans = japanese_target('光を放つ キララ！', SudachiReading(kakasi()))
        self.assertEqual(target, 'hikariwohanatsukirara')
        self.assertEqual(spans[4][0], spans[4][1])
        self.assertEqual(spans[-1][0], spans[-1][1])

    def test_deleted_romaji_still_uses_full_spoken_reading(self):
        spoken = 'nagakunarunara'
        edited = 'naganarunara'
        indices = subsequence_indices(edited, spoken)
        self.assertIsNotNone(indices)
        self.assertEqual(''.join(spoken[index] for index in indices), edited)
        self.assertEqual(indices[4], spoken.index('n', 6))
        self.assertIsNone(subsequence_indices('abc', spoken))

    def test_next_line_anchor_can_extend_an_early_lrc_end(self):
        self.assertAlmostEqual(anchored_line_end([10, 20, 30], 2, 0, 4, 40, 1.5), 2.33)
        self.assertEqual(anchored_line_end([10, 20], 2, 0, 4, 40, 1.5), 1.5)

    def test_different_middle_spelling_keeps_matching_tail_in_place(self):
        spoken = 'hikariwohanatsukirarakirara'
        display = 'hikariwohouttsukirarakirara'
        positions = reading_indices(display, spoken)
        self.assertIsNotNone(positions)
        tail = len('kirarakirara')
        self.assertEqual(positions[-tail:], list(map(float, range(len(spoken) - tail, len(spoken)))))
        self.assertIsNone(reading_indices('zzzzzz', spoken))

    def test_compressed_japanese_glyphs_keep_usable_syllable_time(self):
        units = units_from_centers('キララ', [(0, 2), (2, 4), (4, 6)],
                                   [10, 11, 20, 21, 22, 23], 0, 2, 100, 0, 2, 0.08)
        self.assertTrue(all(unit['end'] - unit['start'] >= 0.079 for unit in units))
        self.assertEqual(len(phoneme_times([(0, 2), (2, 4), (4, 6)], units, 6)), 6)


if __name__ == '__main__':
    unittest.main()
